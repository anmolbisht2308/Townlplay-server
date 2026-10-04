import { addDays, bookableDates, istDate } from "@townplay/shared";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { CoachingBatchModel } from "../src/models/coachingBatch.js";
import { MembershipModel } from "../src/models/membership.js";
import { seed } from "../src/scripts/seed.js";
import { agent, liveVenue, payHold } from "./factories.js";
import { setupApp } from "./helpers.js";

type Ctx = ReturnType<typeof setupApp>;
type Agent = Awaited<ReturnType<typeof agent>>;
const member = { name: "Asha Gupta", phone: "9876543210" };
const DAY_MS = 86_400_000;

const planInput = (over: Record<string, unknown> = {}) => ({
  name: "Monthly member",
  description: "10% off up to 1 booking a month",
  durationMonths: 1,
  pricePaise: 99900,
  discountPercent: 10,
  bookingsPerMonth: 1,
  isActive: true,
  ...over,
});

const batchInput = (resourceId: string | null, over: Record<string, unknown> = {}) => ({
  title: "Evening football",
  activity: "Football",
  coachName: "Coach Ravi",
  description: "",
  capacity: 10,
  monthlyFeePaise: 150000,
  resourceId,
  days: [0, 1, 2, 3, 4, 5, 6],
  startTime: "18:00",
  endTime: "19:00",
  startDate: istDate(),
  ...over,
});

async function venueWithCourt(ctx: Ctx) {
  const owner = await agent(ctx, "owner@example.com");
  const ids = await liveVenue(ctx, owner);
  const resourceId = (await owner.get(`/v1/venues/${ids.venueId}/resources`)).body[0].id as string;
  return { owner, resourceId, ...ids };
}

async function payMembership(player: Agent, membershipId: string) {
  const order = await player.post("/v1/payments/orders", { membershipId }).expect(201);
  return player.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);
}

describe("membership plans", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("owner sells a plan; a member pays and gets the discount within the monthly cap", async () => {
    const { owner, venueId, resourceId } = await venueWithCourt(ctx);
    const stranger = await agent(ctx, "stranger@example.com");
    await stranger.post(`/v1/owner/venues/${venueId}/plans`, planInput()).expect(404);
    await owner
      .post(`/v1/owner/venues/${venueId}/plans`, planInput({ durationMonths: 2 }))
      .expect(400);
    const plan = await owner.post(`/v1/owner/venues/${venueId}/plans`, planInput()).expect(201);

    const offers = await request(ctx.app).get(`/v1/venues/${venueId}/offerings`).expect(200);
    expect(offers.body.plans).toEqual([expect.objectContaining({ id: plan.body.id })]);

    const player = await agent(ctx, "player@example.com");
    await request(ctx.app)
      .post("/v1/memberships")
      .send({ planId: plan.body.id, member })
      .expect(401);
    const joined = await player
      .post("/v1/memberships", { planId: plan.body.id, member })
      .expect(201);
    expect(joined.body).toMatchObject({ status: "pending_payment", pricePaise: 99900 });
    await player.post("/v1/memberships", { planId: plan.body.id, member }).expect(409);
    await payMembership(player, joined.body.id);
    const active = await player.get(`/v1/memberships/${joined.body.id}`).expect(200);
    expect(active.body).toMatchObject({ status: "active", startsOn: istDate(), renewable: true });
    await stranger.get(`/v1/memberships/${joined.body.id}`).expect(404);

    const date = bookableDates()[2]!;
    const first = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["10:00"], customer: member })
      .expect(201);
    expect(first.body.memberDiscountPaise).toBeGreaterThan(0);
    await payHold(player, first.body.id);
    const second = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["11:00"], customer: member })
      .expect(201);
    expect(second.body.memberDiscountPaise).toBe(0); // monthly cap of 1 used up
    const mine = await player.get(`/v1/memberships/${joined.body.id}`).expect(200);
    expect(mine.body.bookingsUsedThisMonth).toBeGreaterThanOrEqual(1);
  });

  it("renewal starts after the current period; reminders go out once; owner sees members", async () => {
    const { owner, venueId } = await venueWithCourt(ctx);
    const plan = await owner.post(`/v1/owner/venues/${venueId}/plans`, planInput()).expect(201);
    const player = await agent(ctx, "player@example.com");
    const m = await player.post("/v1/memberships", { planId: plan.body.id, member }).expect(201);
    await payMembership(player, m.body.id);

    // 2 days before the end: reminder.
    const endsOn = m.body.endsOn as string;
    ctx.clock.offsetMs = Date.parse(`${addDays(endsOn, -2)}T06:00:00Z`) - Date.now();
    expect(await ctx.services.memberships.sendReminders()).toBe(1);
    expect(await ctx.services.memberships.sendReminders()).toBe(0);
    expect(ctx.email.sent.some((e) => e.subject.includes("ends on"))).toBe(true);

    const renewal = await player.post(`/v1/memberships/${m.body.id}/renew`).expect(201);
    expect(renewal.body.startsOn).toBe(addDays(endsOn, 1));
    await player.post(`/v1/memberships/${m.body.id}/renew`).expect(409);
    await payMembership(player, renewal.body.id);

    const current = await owner.get(`/v1/owner/venues/${venueId}/members`).expect(200);
    expect(current.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: m.body.id, renewed: true, name: "Monthly member" }),
      ]),
    );
    await request(ctx.app).get(`/v1/owner/venues/${venueId}/members`).expect(401);

    ctx.clock.offsetMs = Date.parse(`${addDays(endsOn, 1)}T06:00:00Z`) - Date.now();
    expect(await ctx.services.memberships.expireEnded()).toBe(1);
    const old = await player.get(`/v1/memberships/${m.body.id}`).expect(200);
    expect(old.body.status).toBe("expired");
  });
});

describe("coaching batches", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("a batch reserves its court slots ahead; clashes are refused; ending frees them", async () => {
    const { owner, venueId, resourceId } = await venueWithCourt(ctx);
    const batch = await owner
      .post(`/v1/owner/venues/${venueId}/batches`, batchInput(resourceId))
      .expect(201);
    expect(batch.body).toMatchObject({ seatsLeft: 10, resourceName: "Turf A", status: "active" });

    const tomorrow = addDays(istDate(), 1);
    const avail = await request(ctx.app)
      .get(`/v1/venues/${venueId}/availability?date=${tomorrow}`)
      .expect(200);
    const slot = avail.body.resources[0].slots.find(
      (s: { startTime: string }) => s.startTime === "18:00",
    );
    expect(slot.status).toBe("taken");
    const cal = await owner.get(`/v1/venues/${venueId}/calendar?date=${tomorrow}`).expect(200);
    expect(cal.body.bookings).toEqual([
      expect.objectContaining({
        source: "batch",
        startTime: "18:00",
        note: expect.stringContaining("Evening football"),
      }),
    ]);

    const clash = await owner.post(
      `/v1/owner/venues/${venueId}/batches`,
      batchInput(resourceId, { title: "Another" }),
    );
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("SLOT_TAKEN");
    expect(clash.body.error.details.dates).toContain(tomorrow);
    expect(await CoachingBatchModel.countDocuments()).toBe(1);

    // Outside opening hours (closes 23:00).
    await owner
      .post(
        `/v1/owner/venues/${venueId}/batches`,
        batchInput(resourceId, { startTime: "22:00", endTime: "24:00" }),
      )
      .expect(409);

    // A walk-in can't take a batch slot either (same slotLocks index).
    await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date: tomorrow,
        startTimes: ["18:00"],
        source: "walkin",
        customer: member,
      })
      .expect(409);

    await owner.post(`/v1/owner/batches/${batch.body.id}/end`).expect(200);
    const freed = await request(ctx.app)
      .get(`/v1/venues/${venueId}/availability?date=${tomorrow}`)
      .expect(200);
    expect(
      freed.body.resources[0].slots.find((s: { startTime: string }) => s.startTime === "18:00")
        .status,
    ).toBe("available");
  });

  it("the daily job keeps slots reserved further ahead as days pass", async () => {
    const { owner, venueId, resourceId } = await venueWithCourt(ctx);
    const batch = await owner
      .post(`/v1/owner/venues/${venueId}/batches`, batchInput(resourceId, { days: [1] }))
      .expect(201);
    ctx.clock.offsetMs = 7 * DAY_MS;
    expect(await ctx.services.memberships.topUpBatchLocks()).toBe(1);
    expect(await ctx.services.memberships.topUpBatchLocks()).toBe(0);
    const stored = await CoachingBatchModel.findById(batch.body.id).lean();
    expect(stored?.locksUntil).toBe(addDays(istDate(new Date(Date.now() + 7 * DAY_MS)), 27));
  });

  it("parallel joins never overfill: 3 seats, 6 players → 3 in, 3 BATCH_FULL", async () => {
    const { owner, venueId } = await venueWithCourt(ctx);
    const batch = await owner
      .post(`/v1/owner/venues/${venueId}/batches`, batchInput(null, { capacity: 3 }))
      .expect(201);
    const players = await Promise.all(
      Array.from({ length: 6 }, (_, i) => agent(ctx, `p${i}@example.com`)),
    );
    const results = await Promise.all(
      players.map((p) => p.post("/v1/memberships", { batchId: batch.body.id, member })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.error.code)).toEqual([
      "BATCH_FULL",
      "BATCH_FULL",
      "BATCH_FULL",
    ]);
    const stored = await CoachingBatchModel.findById(batch.body.id).lean();
    expect(stored?.seatsTaken).toBe(3);
  });

  it("an unpaid seat is freed when its hold expires; a late payment re-takes a free seat", async () => {
    const { owner, venueId } = await venueWithCourt(ctx);
    const batch = await owner
      .post(`/v1/owner/venues/${venueId}/batches`, batchInput(null, { capacity: 1 }))
      .expect(201);
    const a = await agent(ctx, "a@example.com");
    const joined = await a.post("/v1/memberships", { batchId: batch.body.id, member }).expect(201);
    const order = await a.post("/v1/payments/orders", { membershipId: joined.body.id }).expect(201);
    ctx.clock.offsetMs = 16 * 60_000;
    expect(await ctx.services.memberships.expireHolds()).toBe(1);
    expect((await CoachingBatchModel.findById(batch.body.id).lean())?.seatsTaken).toBe(0);

    await a.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);
    const after = await a.get(`/v1/memberships/${joined.body.id}`).expect(200);
    expect(after.body.status).toBe("active");
    expect((await CoachingBatchModel.findById(batch.body.id).lean())?.seatsTaken).toBe(1);
  });

  it("a late payment for a batch that filled up meanwhile is refunded in full", async () => {
    const { owner, venueId } = await venueWithCourt(ctx);
    const batch = await owner
      .post(`/v1/owner/venues/${venueId}/batches`, batchInput(null, { capacity: 1 }))
      .expect(201);
    const a = await agent(ctx, "a@example.com");
    const b = await agent(ctx, "b@example.com");
    const ja = await a.post("/v1/memberships", { batchId: batch.body.id, member }).expect(201);
    const order = await a.post("/v1/payments/orders", { membershipId: ja.body.id }).expect(201);
    ctx.clock.offsetMs = 16 * 60_000;
    await ctx.services.memberships.expireHolds();
    const jb = await b.post("/v1/memberships", { batchId: batch.body.id, member }).expect(201);
    await payMembership(b, jb.body.id);

    await a.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);
    const late = await a.get(`/v1/memberships/${ja.body.id}`).expect(200);
    expect(late.body.status).toBe("cancelled");
    expect(ctx.gateway.refunds).toEqual([
      expect.objectContaining({ amountPaise: order.body.amountPaise }),
    ]);
  });

  it("renewals keep the seat; owner marks attendance and cancels with a refund", async () => {
    const { owner, venueId } = await venueWithCourt(ctx);
    const batch = await owner
      .post(`/v1/owner/venues/${venueId}/batches`, batchInput(null, { capacity: 1 }))
      .expect(201);
    const a = await agent(ctx, "a@example.com");
    const m = await a.post("/v1/memberships", { batchId: batch.body.id, member }).expect(201);
    await payMembership(a, m.body.id);
    const r = await a.post(`/v1/memberships/${m.body.id}/renew`).expect(201);
    await payMembership(a, r.body.id);
    expect((await CoachingBatchModel.findById(batch.body.id).lean())?.seatsTaken).toBe(1);

    // Attendance today.
    const today = istDate();
    const sheet = await owner
      .get(`/v1/owner/batches/${batch.body.id}/attendance?date=${today}`)
      .expect(200);
    expect(sheet.body).toMatchObject({ scheduled: true });
    expect(sheet.body.members).toEqual([expect.objectContaining({ membershipId: m.body.id })]);
    const marked = await owner
      .put(`/v1/owner/batches/${batch.body.id}/attendance`, { date: today, present: [m.body.id] })
      .expect(200);
    expect(marked.body.members[0].present).toBe(true);
    await owner
      .put(`/v1/owner/batches/${batch.body.id}/attendance`, {
        date: addDays(today, 1),
        present: [],
      })
      .expect(400);
    await owner
      .put(`/v1/owner/batches/${batch.body.id}/attendance`, { date: today, present: [r.body.id] })
      .expect(400); // the renewal starts later
    const stranger = await agent(ctx, "stranger@example.com");
    await stranger.get(`/v1/owner/batches/${batch.body.id}/attendance?date=${today}`).expect(404);

    // The period ends: the seat passes to the paid renewal.
    ctx.clock.offsetMs = Date.parse(`${addDays(m.body.endsOn, 1)}T06:00:00Z`) - Date.now();
    await ctx.services.memberships.expireEnded();
    expect((await CoachingBatchModel.findById(batch.body.id).lean())?.seatsTaken).toBe(1);
    expect((await MembershipModel.findById(r.body.id).lean())?.seatHeld).toBe(true);

    const cancelled = await owner
      .post(`/v1/owner/memberships/${r.body.id}/cancel`, { reason: "Coach left" })
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(ctx.gateway.refunds.at(-1)?.amountPaise).toBe(
      r.body.pricePaise + r.body.convenienceFeePaise,
    );
    expect((await CoachingBatchModel.findById(batch.body.id).lean())?.seatsTaken).toBe(0);
  });

  it("membership fees count in owner earnings", async () => {
    const { owner, venueId, businessId } = await venueWithCourt(ctx);
    const plan = await owner.post(`/v1/owner/venues/${venueId}/plans`, planInput()).expect(201);
    const player = await agent(ctx, "player@example.com");
    const m = await player.post("/v1/memberships", { planId: plan.body.id, member }).expect(201);
    await payMembership(player, m.body.id);
    const today = istDate();
    const earnings = await owner
      .get(`/v1/businesses/${businessId}/earnings?from=${today}&to=${today}`)
      .expect(200);
    expect(earnings.body).toMatchObject({
      membershipsOnlinePaise: 99900,
      advanceOnlinePaise: 99900,
      payoutDuePaise: 99900,
    });
  });
});
