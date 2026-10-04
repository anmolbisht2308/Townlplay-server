import { bookableDates } from "@townplay/shared";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { BookingModel } from "../src/models/booking.js";
import { PaymentModel } from "../src/models/payment.js";
import { ProcessedEventModel } from "../src/models/processedEvent.js";
import { seed } from "../src/scripts/seed.js";
import { adminAgent, agent, liveVenue, payHold } from "./factories.js";
import { setupApp, WEB_ORIGIN } from "./helpers.js";

const customer = { name: "Rahul", phone: "9876543210" };

describe("payments", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  async function setup() {
    const owner = await agent(ctx, "owner@example.com");
    const ids = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${ids.venueId}/resources`)).body[0]
      .id as string;
    const player = await agent(ctx, "player@example.com");
    return { owner, player, resourceId, date: bookableDates()[2]!, ...ids };
  }

  function webhook(event: object, eventId = `evt_${Math.random().toString(36).slice(2)}`) {
    const raw = JSON.stringify(event);
    return request(ctx.app)
      .post("/v1/webhooks/razorpay")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", ctx.gateway.webhookSignature(raw))
      .set("x-razorpay-event-id", eventId)
      .send(raw);
  }

  const captured = (orderId: string, paymentId = "pay_hook_1") => ({
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
  });

  it("charges advance + admin convenience fee and shows the breakdown on the hold", async () => {
    const { player, resourceId, date } = await setup();
    const admin = await adminAgent(ctx);
    await admin
      .put("/v1/admin/settings", { convenienceFee: { flatPaise: 1000, percent: 2 } })
      .expect(200);
    expect((await admin.get("/v1/admin/settings")).body.convenienceFee).toEqual({
      flatPaise: 1000,
      percent: 2,
    });
    await player.get("/v1/admin/settings").expect(403);

    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["10:00"], customer })
      .expect(201);
    const { advancePaise, convenienceFeePaise } = hold.body.amount;
    expect(convenienceFeePaise).toBe(1000 + Math.round(advancePaise * 0.02));

    const order = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);
    expect(order.body).toMatchObject({
      provider: "fake",
      amountPaise: advancePaise + convenienceFeePaise,
      currency: "INR",
    });
    // Asking again returns the same order.
    const again = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);
    expect(again.body.orderId).toBe(order.body.orderId);
    expect(ctx.gateway.orders).toHaveLength(1);
    const stranger = await agent(ctx, "stranger@example.com");
    await stranger.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(404);
  });

  it("confirms from the webhook alone (browser closed) and ignores replays", async () => {
    const { player, resourceId, date } = await setup();
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["11:00"], customer })
      .expect(201);
    const order = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);

    await webhook(captured(order.body.orderId), "evt_1").expect(200, {
      ok: true,
      duplicate: false,
    });
    expect((await BookingModel.findById(hold.body.id))?.status).toBe("confirmed");
    expect((await PaymentModel.findOne({ razorpayOrderId: order.body.orderId }))?.status).toBe(
      "paid",
    );

    await webhook(captured(order.body.orderId), "evt_1").expect(200, { ok: true, duplicate: true });
    await webhook(captured(order.body.orderId), "evt_2").expect(200, {
      ok: true,
      duplicate: false,
    });
    expect(await ProcessedEventModel.countDocuments()).toBe(2);
    // One confirmation email to the player and one to the owner, not repeated by replays.
    expect(ctx.email.sent.filter((m) => m.subject.startsWith("Booking confirmed"))).toHaveLength(1);
    expect(ctx.email.sent.filter((m) => m.subject.startsWith("New booking"))).toHaveLength(1);
    expect(ctx.push.sent).toHaveLength(1);
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await request(ctx.app)
      .post("/v1/webhooks/razorpay")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", "0".repeat(64))
      .send(JSON.stringify(captured("order_x")))
      .expect(400);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect(await ProcessedEventModel.countDocuments()).toBe(0);
  });

  it("verifies checkout signatures", async () => {
    const { player, resourceId, date } = await setup();
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["12:00"], customer })
      .expect(201);
    const order = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);
    const bad = await player
      .post("/v1/payments/verify", {
        razorpayOrderId: order.body.orderId,
        razorpayPaymentId: "pay_1",
        razorpaySignature: "a".repeat(64),
      })
      .expect(400);
    expect(bad.body.error.code).toBe("INVALID_SIGNATURE");
    const ok = await player
      .post("/v1/payments/verify", {
        razorpayOrderId: order.body.orderId,
        razorpayPaymentId: "pay_1",
        razorpaySignature: ctx.gateway.checkoutSignature(order.body.orderId, "pay_1"),
      })
      .expect(200);
    expect(ok.body.status).toBe("confirmed");
    // The webhook arriving afterwards is a no-op.
    await webhook(captured(order.body.orderId, "pay_1")).expect(200);
    expect(ctx.email.sent.filter((m) => m.subject.startsWith("Booking confirmed"))).toHaveLength(1);
  });

  it("late payment for a slot someone else took is cancelled and refunded in full", async () => {
    const { player, resourceId, date } = await setup();
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["13:00"], customer })
      .expect(201);
    const order = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);
    ctx.clock.offsetMs = 11 * 60_000;
    const other = await agent(ctx, "other@example.com");
    await other
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["13:00"], customer })
      .expect(201);

    await webhook(captured(order.body.orderId, "pay_late")).expect(200);
    const booking = await BookingModel.findById(hold.body.id).lean();
    expect(booking?.status).toBe("cancelled");
    expect(booking?.cancellation).toMatchObject({ by: "system", refundStatus: "processed" });
    expect(ctx.gateway.refunds).toEqual([
      expect.objectContaining({ paymentId: "pay_late", amountPaise: order.body.amountPaise }),
    ]);
    expect((await PaymentModel.findOne({ razorpayOrderId: order.body.orderId }))?.status).toBe(
      "refunded",
    );
  });

  it("late payment for a slot that is still free re-locks and confirms", async () => {
    const { player, resourceId, date } = await setup();
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["14:00"], customer })
      .expect(201);
    const order = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);
    ctx.clock.offsetMs = 11 * 60_000;
    await ctx.bookings.expireHolds();
    await webhook(captured(order.body.orderId, "pay_late2")).expect(200);
    expect((await BookingModel.findById(hold.body.id))?.status).toBe("confirmed");
    const other = await agent(ctx, "other@example.com");
    await other
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["14:00"], customer })
      .expect(409);
  });

  it("refunds per policy: nothing after the cutoff, everything (fee included) when the owner cancels", async () => {
    const { owner, player, resourceId, date } = await setup();
    const admin = await adminAgent(ctx);
    await admin
      .put("/v1/admin/settings", { convenienceFee: { flatPaise: 500, percent: 0 } })
      .expect(200);

    const a = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["15:00"], customer })
      .expect(201);
    await payHold(player, a.body.id);
    const ownerCancel = await owner
      .post(`/v1/bookings/${a.body.id}/cancel`, { reason: "Rain" })
      .expect(200);
    expect(ownerCancel.body.cancellation).toMatchObject({
      by: "owner",
      refundPaise: a.body.amount.advancePaise + 500,
    });

    const b = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["16:00"], customer })
      .expect(201);
    await payHold(player, b.body.id);
    // Three hours before the 16:00 start: inside the 6 h cutoff.
    ctx.clock.offsetMs = Date.parse(`${date}T13:00:00+05:30`) - Date.now();
    const late = await player.post(`/v1/bookings/${b.body.id}/cancel`, {}).expect(200);
    expect(late.body.cancellation).toMatchObject({ refundPaise: 0, refundStatus: "none" });
    expect(ctx.gateway.refunds).toHaveLength(1);
  });

  it("test-mode payment failure leaves the hold unpaid", async () => {
    const { player, resourceId, date } = await setup();
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["17:00"], customer })
      .expect(201);
    const order = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(201);
    await player
      .post("/v1/payments/fake-pay", { orderId: order.body.orderId, outcome: "failure" })
      .expect(200);
    expect((await PaymentModel.findOne({ razorpayOrderId: order.body.orderId }))?.status).toBe(
      "failed",
    );
    expect((await BookingModel.findById(hold.body.id))?.status).toBe("pending_payment");
    // Retrying succeeds.
    await player.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);
    expect((await BookingModel.findById(hold.body.id))?.status).toBe("confirmed");
  });
});

describe("payouts and earnings", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("saves bank details without exposing them, reports earnings, and records manual payouts", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId, businessId } = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${venueId}/resources`)).body[0].id;
    const date = bookableDates()[1]!;

    const bank = {
      accountHolderName: "Green Arena LLP",
      accountNumber: "123456789012",
      ifsc: "HDFC0001234",
    };
    const setupRes = await owner.post(`/v1/businesses/${businessId}/payout`, bank).expect(200);
    expect(setupRes.body.payout).toEqual({
      mode: "manual",
      status: "active",
      accountHolderName: "Green Arena LLP",
      accountLast4: "9012",
      ifsc: "HDFC0001234",
    });
    expect(JSON.stringify(setupRes.body)).not.toContain("123456789012");
    const other = await agent(ctx, "other@example.com");
    await other.post(`/v1/businesses/${businessId}/payout`, bank).expect(404);

    const player = await agent(ctx, "player@example.com");
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["09:00"], customer })
      .expect(201);
    await payHold(player, hold.body.id);
    const walkin = await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["10:00"],
        source: "walkin",
        customer,
      })
      .expect(201);
    await owner.post(`/v1/bookings/${walkin.body.id}/balance`, { method: "cash" }).expect(200);

    const earnings = await owner
      .get(`/v1/businesses/${businessId}/earnings?from=${date}&to=${date}`)
      .expect(200);
    expect(earnings.body).toMatchObject({
      bookings: 2,
      bookedValuePaise: hold.body.amount.totalPaise + walkin.body.amount.totalPaise,
      advanceOnlinePaise: hold.body.amount.advancePaise,
      balanceCollectedPaise: walkin.body.amount.totalPaise,
      payoutDuePaise: hold.body.amount.advancePaise,
    });
    await other.get(`/v1/businesses/${businessId}/earnings?from=${date}&to=${date}`).expect(404);

    const admin = await adminAgent(ctx);
    const report = await admin.get("/v1/admin/payouts").expect(200);
    expect(report.body[0]).toMatchObject({
      businessId,
      payoutDuePaise: hold.body.amount.advancePaise,
    });
    await admin
      .post("/v1/admin/payouts", {
        businessId,
        amountPaise: hold.body.amount.advancePaise,
        reference: "NEFT 123",
      })
      .expect(201);
    expect((await admin.get("/v1/admin/payouts")).body[0].payoutDuePaise).toBe(0);
    await owner
      .post("/v1/admin/payouts", { businessId, amountPaise: 100, reference: "x y z" })
      .expect(403);
  });
});

describe("route payouts", () => {
  const ctx = setupApp({ PAYOUTS_MODE: "route" });
  beforeEach(() => seed(undefined));

  it("transfers the advance to the linked account on capture and reverses it on refund", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId, businessId } = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${venueId}/resources`)).body[0].id;
    const setupRes = await owner
      .post(`/v1/businesses/${businessId}/payout`, {
        accountHolderName: "Green Arena LLP",
        accountNumber: "123456789012",
        ifsc: "HDFC0001234",
      })
      .expect(200);
    expect(setupRes.body.payout).toMatchObject({ mode: "route", status: "active" });

    const player = await agent(ctx, "player@example.com");
    const date = bookableDates()[3]!;
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["09:00"], customer })
      .expect(201);
    await payHold(player, hold.body.id);
    expect(ctx.gateway.transfers).toEqual([
      expect.objectContaining({ amountPaise: hold.body.amount.advancePaise }),
    ]);

    await owner.post(`/v1/bookings/${hold.body.id}/cancel`, {}).expect(200);
    expect(ctx.gateway.reversals).toEqual([
      expect.objectContaining({ amountPaise: hold.body.amount.advancePaise }),
    ]);
  });
});

describe("push subscriptions", () => {
  const ctx = setupApp({ VAPID_PUBLIC_KEY: "BPublicKeyForTests" });
  beforeEach(() => seed(undefined));

  it("serves the public key and saves/removes subscriptions for signed-in users", async () => {
    expect((await request(ctx.app).get("/v1/push/public-key").expect(200)).body).toEqual({
      publicKey: "BPublicKeyForTests",
    });
    const sub = {
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "p".repeat(40), auth: "a".repeat(20) },
    };
    await request(ctx.app)
      .post("/v1/push/subscriptions")
      .set("Origin", WEB_ORIGIN)
      .send(sub)
      .expect(401);
    const owner = await agent(ctx, "owner@example.com");
    await owner.post("/v1/push/subscriptions", sub).expect(204);
    await owner.post("/v1/push/subscriptions", sub).expect(204);
    await owner.delete("/v1/push/subscriptions").send({ endpoint: sub.endpoint }).expect(204);
  });
});
