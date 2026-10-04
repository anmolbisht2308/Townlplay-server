import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { EventModel } from "../src/models/event.js";
import { TicketModel } from "../src/models/ticket.js";
import { TicketOrderModel } from "../src/models/ticketOrder.js";
import { seed } from "../src/scripts/seed.js";
import {
  adminAgent,
  agent,
  businessInput,
  eventInput,
  liveEvent,
  payTicketOrder,
} from "./factories.js";
import { setupApp } from "./helpers.js";

const buyer = { name: "Asha", phone: "9876543210" };

describe("event listing and review", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("owners create events that go live after admin review", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const business = await owner.post("/v1/businesses", businessInput()).expect(201);
    const bad = await owner.post("/v1/events", eventInput(business.body.id, { address: null }));
    expect(bad.status).toBe(400);
    const event = await owner.post("/v1/events", eventInput(business.body.id)).expect(201);
    expect(event.body).toMatchObject({
      status: "draft",
      tiers: [{ remaining: 20 }, { remaining: 5 }],
    });

    await request(ctx.app)
      .get("/v1/cities/bareilly/events")
      .expect(200, { items: [], nextCursor: null });
    await owner.post(`/v1/events/${event.body.id}/submit`).expect(200);
    const admin = await adminAgent(ctx);
    const queue = await admin.get("/v1/admin/review?kind=event").expect(200);
    expect(queue.body[0]).toMatchObject({ id: event.body.id, kind: "event" });
    await admin.post(`/v1/admin/events/${event.body.id}/approve`).expect(200);

    const list = await request(ctx.app).get("/v1/cities/bareilly/events").expect(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({ title: "Diwali Mela", minPricePaise: 0, soldOut: false }),
    ]);
    const page = await request(ctx.app)
      .get(`/v1/events/by-slug/bareilly/${event.body.slug}`)
      .expect(200);
    expect(page.body).toMatchObject({ organiserName: "Green Arena", cancelled: false });
    expect(page.body).not.toHaveProperty("businessId");

    const other = await agent(ctx, "other@example.com");
    await other.patch(`/v1/events/${event.body.id}`, { title: "Mine" }).expect(404);
    await other.get(`/v1/events/${event.body.id}/dashboard`).expect(404);
  });

  it("tier edits keep sold tickets: no shrinking below sales, no removing sold tiers", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, paidTierId, freeTierId } = await liveEvent(ctx, owner);
    const fan = await agent(ctx, "fan@example.com");
    const order = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 3 }], buyer })
      .expect(201);
    await payTicketOrder(fan, order.body.id);

    const shrink = await owner.patch(`/v1/events/${eventId}`, {
      tiers: [
        { id: paidTierId, name: "Entry", pricePaise: 20000, capacity: 2 },
        { id: freeTierId, name: "Free pass", pricePaise: 0, capacity: 5 },
      ],
    });
    expect(shrink.status).toBe(409);
    expect(shrink.body.error.code).toBe("TIER_OVERSOLD");
    await owner
      .patch(`/v1/events/${eventId}`, {
        tiers: [{ id: freeTierId, name: "Free pass", pricePaise: 0, capacity: 5 }],
      })
      .expect(409);
    const grow = await owner
      .patch(`/v1/events/${eventId}`, {
        tiers: [
          { id: paidTierId, name: "Entry", pricePaise: 20000, capacity: 30 },
          { id: freeTierId, name: "Free pass", pricePaise: 0, capacity: 5 },
        ],
      })
      .expect(200);
    expect(grow.body.tiers[0]).toMatchObject({ capacity: 30, remaining: 27 });
  });
});

describe("tickets", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("100 parallel purchases for a 20-ticket tier never sell more than 20", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, paidTierId } = await liveEvent(ctx, owner);
    const fans = await Promise.all(
      Array.from({ length: 5 }, (_, i) => agent(ctx, `fan${i}@example.com`)),
    );
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fans[i % fans.length]!.post("/v1/ticket-orders", {
          eventId,
          items: [{ tierId: paidTierId, qty: 1 }],
          buyer,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.error.code === "SOLD_OUT"),
    ).toBe(true);
    const event = await EventModel.findById(eventId).lean();
    expect(event?.tiers[0]?.remaining).toBe(0);
  });

  it("pays, issues QR tickets, and holds expire back into stock", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, paidTierId } = await liveEvent(ctx, owner);
    const fan = await agent(ctx, "fan@example.com");
    const order = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 2 }], buyer })
      .expect(201);
    expect(order.body).toMatchObject({ status: "pending_payment", totalPaise: 40000, tickets: [] });
    expect((await EventModel.findById(eventId).lean())?.tiers[0]?.remaining).toBe(18);

    const paid = await payTicketOrder(fan, order.body.id);
    expect(paid).toMatchObject({ refType: "ticketOrder", status: "paid" });
    const mine = await fan.get(`/v1/ticket-orders/${order.body.id}`).expect(200);
    expect(mine.body.tickets).toHaveLength(2);
    expect(mine.body.tickets[0].qrToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(ctx.email.sent.some((m) => m.subject.startsWith("Your tickets"))).toBe(true);
    // The organiser sees the order but never the QR tokens.
    const asOwner = await owner.get(`/v1/ticket-orders/${order.body.id}`).expect(200);
    expect(asOwner.body.tickets[0].qrToken).toBeNull();

    const held = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 5 }], buyer })
      .expect(201);
    expect((await EventModel.findById(eventId).lean())?.tiers[0]?.remaining).toBe(13);
    ctx.clock.offsetMs = 11 * 60_000;
    expect(await ctx.services.tickets.expireHolds()).toBe(1);
    expect((await EventModel.findById(eventId).lean())?.tiers[0]?.remaining).toBe(18);
    await fan.post("/v1/payments/orders", { ticketOrderId: held.body.id }).expect(409);
  });

  it("free tiers are RSVPs: confirmed at once with tickets", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, freeTierId } = await liveEvent(ctx, owner);
    const fan = await agent(ctx, "fan@example.com");
    const rsvp = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: freeTierId, qty: 2 }], buyer })
      .expect(201);
    expect(rsvp.body.status).toBe("paid");
    expect(rsvp.body.tickets).toHaveLength(2);
    const sold = await fan.post("/v1/ticket-orders", {
      eventId,
      items: [{ tierId: freeTierId, qty: 4 }],
      buyer,
    });
    expect(sold.status).toBe(409);
  });

  it("checks in once: reuse says already, unknown and other-event tokens are rejected", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, freeTierId } = await liveEvent(ctx, owner);
    const second = await owner
      .post(
        "/v1/events",
        eventInput((await owner.get("/v1/businesses/mine")).body[0].id, { title: "Other night" }),
      )
      .expect(201);
    const fan = await agent(ctx, "fan@example.com");
    const rsvp = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: freeTierId, qty: 1 }], buyer })
      .expect(201);
    const qrToken = rsvp.body.tickets[0].qrToken as string;

    const scans = await Promise.all(
      [1, 2, 3].map(() => owner.post(`/v1/events/${eventId}/checkin`, { qrToken })),
    );
    expect(scans.map((s) => s.body.result).sort()).toEqual(["already", "already", "ok"]);
    const again = await owner.post(`/v1/events/${eventId}/checkin`, { qrToken }).expect(200);
    expect(again.body).toMatchObject({ result: "already", ticket: { holderName: "Asha" } });
    expect(again.body.ticket.checkedInAt).toBeTruthy();

    expect(
      (await owner.post(`/v1/events/${eventId}/checkin`, { qrToken: "x".repeat(24) })).body.result,
    ).toBe("invalid");
    expect(
      (await owner.post(`/v1/events/${second.body.id}/checkin`, { qrToken })).body.result,
    ).toBe("wrong_event");
    await fan.post(`/v1/events/${eventId}/checkin`, { qrToken }).expect(404);
  });

  it("organiser dashboard, attendee search and CSV export", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, paidTierId, freeTierId } = await liveEvent(ctx, owner);
    const fan = await agent(ctx, "fan@example.com");
    const order = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 2 }], buyer })
      .expect(201);
    await payTicketOrder(fan, order.body.id);
    const rsvp = await fan
      .post("/v1/ticket-orders", {
        eventId,
        items: [{ tierId: freeTierId, qty: 1 }],
        buyer: { name: "=Ravi", phone: "9123456780" },
      })
      .expect(201);
    await owner
      .post(`/v1/events/${eventId}/tickets/${rsvp.body.tickets[0].id}/checkin`)
      .expect(200);

    const dash = await owner.get(`/v1/events/${eventId}/dashboard`).expect(200);
    expect(dash.body).toMatchObject({ ticketsSold: 3, revenuePaise: 40000, checkedIn: 1 });
    expect(dash.body.tiers[0]).toMatchObject({ sold: 2, capacity: 20 });

    const search = await owner.get(`/v1/events/${eventId}/attendees?q=912345`).expect(200);
    expect(search.body).toHaveLength(1);
    const csv = await owner.get(`/v1/events/${eventId}/attendees.csv`).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("Ticket holder");
    expect(csv.text).toContain("'=Ravi"); // formula injection neutralised
  });

  it("cancelling an event refunds every paid order in full and voids tickets", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, paidTierId, freeTierId, slug } = await liveEvent(ctx, owner);
    const admin = await adminAgent(ctx);
    await admin
      .put("/v1/admin/settings", { convenienceFee: { flatPaise: 1000, percent: 0 } })
      .expect(200);
    const fan = await agent(ctx, "fan@example.com");
    const order = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 2 }], buyer })
      .expect(201);
    expect(order.body.convenienceFeePaise).toBe(1000);
    await payTicketOrder(fan, order.body.id);
    const rsvp = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: freeTierId, qty: 1 }], buyer })
      .expect(201);

    await owner.post(`/v1/events/${eventId}/cancel`, {}).expect(400);
    await owner.post(`/v1/events/${eventId}/cancel`, { reason: "Heavy rain" }).expect(200);
    expect(ctx.gateway.refunds).toEqual([expect.objectContaining({ amountPaise: 41000 })]);
    expect((await TicketOrderModel.findById(order.body.id).lean())?.status).toBe("refunded");
    expect(await TicketModel.countDocuments({ eventId, status: "valid" })).toBe(0);
    const scan = await owner.post(`/v1/events/${eventId}/checkin`, {
      qrToken: rsvp.body.tickets[0].qrToken,
    });
    expect(scan.body.result).toBe("invalid");
    expect(ctx.email.sent.filter((m) => m.subject.startsWith("Cancelled"))).toHaveLength(2);
    const page = await request(ctx.app).get(`/v1/events/by-slug/bareilly/${slug}`).expect(200);
    expect(page.body.cancelled).toBe(true);
    await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 1 }], buyer })
      .expect(404);
  });

  it("late payment after expiry: re-takes stock if any, else refunds in full", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { eventId, paidTierId } = await liveEvent(ctx, owner);
    const fan = await agent(ctx, "fan@example.com");
    const a = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 10 }], buyer })
      .expect(201);
    const orderA = await fan.post("/v1/payments/orders", { ticketOrderId: a.body.id }).expect(201);
    ctx.clock.offsetMs = 11 * 60_000;
    await ctx.services.tickets.expireHolds();
    // Someone buys 15 of the 20 while A is expired: A (10) can no longer fit.
    const b = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 10 }], buyer })
      .expect(201);
    await payTicketOrder(fan, b.body.id);
    const c = await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: paidTierId, qty: 5 }], buyer })
      .expect(201);
    await payTicketOrder(fan, c.body.id);

    await fan.post("/v1/payments/fake-pay", { orderId: orderA.body.orderId }).expect(200);
    expect((await TicketOrderModel.findById(a.body.id).lean())?.status).toBe("refunded");
    expect(ctx.gateway.refunds).toEqual([
      expect.objectContaining({ amountPaise: orderA.body.amountPaise }),
    ]);
    expect((await EventModel.findById(eventId).lean())?.tiers[0]?.remaining).toBe(5);
  });

  it("sends a reminder the day before, once per order", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const startsAt = new Date(Date.now() + 36 * 3_600_000);
    const { eventId, freeTierId } = await liveEvent(ctx, owner, {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    });
    const fan = await agent(ctx, "fan@example.com");
    await fan
      .post("/v1/ticket-orders", { eventId, items: [{ tierId: freeTierId, qty: 1 }], buyer })
      .expect(201);
    // Move the clock to the day before the event (IST).
    ctx.clock.offsetMs = startsAt.getTime() - 24 * 3_600_000 - Date.now();
    expect(await ctx.services.tickets.sendReminders()).toBe(1);
    expect(await ctx.services.tickets.sendReminders()).toBe(0);
    expect(ctx.email.sent.filter((m) => m.subject.startsWith("Tomorrow"))).toHaveLength(1);
  });
});
