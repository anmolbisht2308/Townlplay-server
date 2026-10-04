import { bookableDates, type BookingEvent } from "@townplay/shared";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { BookingModel } from "../src/models/booking.js";
import { SlotLockModel } from "../src/models/slotLock.js";
import { seed } from "../src/scripts/seed.js";
import { agent, liveVenue, payHold } from "./factories.js";
import { setupApp } from "./helpers.js";

const customer = { name: "Rahul", phone: "9876543210" };

describe("availability and holds", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  async function setup() {
    const owner = await agent(ctx, "owner@example.com");
    const ids = await liveVenue(ctx, owner);
    const courts = await owner.get(`/v1/venues/${ids.venueId}/resources`).expect(200);
    const resourceId = courts.body[0].id as string;
    const player = await agent(ctx, "player@example.com");
    const date = bookableDates()[1]!; // tomorrow: no slot is in the past
    return { owner, player, resourceId, date, ...ids };
  }

  it("lists slots with prices for a live venue and rejects dates outside 14 days", async () => {
    const { venueId, resourceId, date } = await setup();
    const res = await request(ctx.app)
      .get(`/v1/venues/${venueId}/availability?date=${date}`)
      .expect(200);
    expect(res.body.resources).toHaveLength(1);
    const slots = res.body.resources[0].slots;
    expect(slots[0]).toMatchObject({ startTime: "06:00", endTime: "07:00", status: "available" });
    expect(slots.every((s: { pricePaise: number }) => s.pricePaise > 0)).toBe(true);
    await request(ctx.app).get(`/v1/resources/${resourceId}/availability?date=${date}`).expect(200);
    const far = "2099-01-01";
    const out = await request(ctx.app)
      .get(`/v1/venues/${venueId}/availability?date=${far}`)
      .expect(400);
    expect(out.body.error.code).toBe("DATE_OUT_OF_RANGE");
  });

  it("holds consecutive slots with amounts, then confirms (dev) and locks permanently", async () => {
    const { player, resourceId, date, venueId } = await setup();
    const events: BookingEvent[] = [];
    const off = ctx.events.subscribe((e) => events.push(e));

    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["08:00", "07:00"], customer })
      .expect(201);
    expect(hold.body).toMatchObject({
      status: "pending_payment",
      startTime: "07:00",
      endTime: "09:00",
      slots: ["07:00", "08:00"],
      source: "online",
      customer,
    });
    expect(hold.body.code).toMatch(/^[A-Z2-9]{6}$/);
    const { totalPaise, advancePaise, balancePaise } = hold.body.amount;
    expect(advancePaise).toBe(Math.round(totalPaise * 0.3));
    expect(balancePaise).toBe(totalPaise - advancePaise);
    expect(events).toContainEqual(expect.objectContaining({ type: "created", venueId, date }));

    const avail = await request(ctx.app).get(
      `/v1/resources/${resourceId}/availability?date=${date}`,
    );
    const taken = avail.body.slots.filter((s: { status: string }) => s.status === "taken");
    expect(taken.map((s: { startTime: string }) => s.startTime)).toEqual(["07:00", "08:00"]);

    const confirmed = await payHold(player, hold.body.id);
    expect(confirmed.status).toBe("confirmed");
    expect(
      await SlotLockModel.countDocuments({ bookingId: hold.body.id, expiresAt: { $exists: true } }),
    ).toBe(0);
    off();
  });

  it("rejects non-consecutive, unknown and taken slots", async () => {
    const { player, resourceId, date } = await setup();
    const bad = await player.post("/v1/bookings/hold", {
      resourceId,
      date,
      startTimes: ["07:00", "09:00"],
      customer,
    });
    expect(bad.status).toBe(400);
    await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["07:30"], customer })
      .expect(400);
    await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["10:00"], customer })
      .expect(201);
    const clash = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["09:00", "10:00"], customer })
      .expect(409);
    expect(clash.body.error.code).toBe("SLOT_TAKEN");
    await player
      .post("/v1/bookings/hold", {
        resourceId,
        date,
        startTimes: ["10:00"],
        customer: { name: "x" },
      })
      .expect(400);
  });

  it("50 parallel holds for the same slot: exactly one succeeds", async () => {
    const { resourceId, date } = await setup();
    const players = await Promise.all(
      Array.from({ length: 5 }, (_, i) => agent(ctx, `p${i}@example.com`)),
    );
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        players[i % players.length]!.post("/v1/bookings/hold", {
          resourceId,
          date,
          startTimes: ["18:00"],
          customer,
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);
    expect(await SlotLockModel.countDocuments({ resourceId, date, startTime: "18:00" })).toBe(1);
    expect(await BookingModel.countDocuments({ resourceId, date })).toBe(1);
  });

  it("expired holds free their slots, cannot be confirmed, and the job marks them expired", async () => {
    const { player, resourceId, date } = await setup();
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["12:00"], customer })
      .expect(201);
    ctx.clock.offsetMs = 11 * 60_000;

    // TTL has not run, but the slot is free again and can be re-held.
    const avail = await request(ctx.app).get(
      `/v1/resources/${resourceId}/availability?date=${date}`,
    );
    expect(
      avail.body.slots.find((s: { startTime: string }) => s.startTime === "12:00").status,
    ).toBe("available");
    const late = await player.post("/v1/payments/orders", { bookingId: hold.body.id }).expect(409);
    expect(late.body.error.code).toBe("HOLD_EXPIRED");
    const again = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["12:00"], customer })
      .expect(201);
    expect(again.body.id).not.toBe(hold.body.id);

    expect(await ctx.bookings.expireHolds()).toBe(1);
    expect((await BookingModel.findById(hold.body.id))?.status).toBe("expired");
  });
});

describe("my bookings and cancellation", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("lists upcoming bookings, cancels with policy refund, and hides others' bookings", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await liveVenue(ctx, owner);
    const courts = await owner.get(`/v1/venues/${venueId}/resources`);
    const resourceId = courts.body[0].id;
    const date = bookableDates()[3]!;
    const player = await agent(ctx, "player@example.com");
    const hold = await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["20:00"], customer })
      .expect(201);
    await payHold(player, hold.body.id);

    const mine = await player.get("/v1/bookings/mine?scope=upcoming").expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].venue).toMatchObject({
      name: "Green Arena Turf",
      contactPhone: "9876543210",
    });
    // Policy: 100% refund until 6 h before.
    expect(mine.body[0].refundIfCancelledNowPaise).toBe(hold.body.amount.advancePaise);

    const stranger = await agent(ctx, "stranger@example.com");
    await stranger.get(`/v1/bookings/${hold.body.id}`).expect(404);
    await stranger.post(`/v1/bookings/${hold.body.id}/cancel`, {}).expect(404);

    const cancelled = await player
      .post(`/v1/bookings/${hold.body.id}/cancel`, { reason: "Rain" })
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.cancellation).toMatchObject({
      by: "player",
      reason: "Rain",
      refundPaise: hold.body.amount.advancePaise,
    });
    expect(await SlotLockModel.countDocuments({ bookingId: hold.body.id })).toBe(0);
    expect((await player.get("/v1/bookings/mine?scope=past")).body).toHaveLength(1);
    await player.post(`/v1/bookings/${hold.body.id}/cancel`, {}).expect(409);
  });
});

describe("owner calendar", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("walk-ins and blocks take slots instantly, and appear on the calendar", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${venueId}/resources`)).body[0].id;
    const date = bookableDates()[1]!;
    const events: BookingEvent[] = [];
    ctx.events.subscribe((e) => events.push(e));

    const walkin = await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["19:00"],
        source: "walkin",
        customer,
      })
      .expect(201);
    expect(walkin.body).toMatchObject({ status: "confirmed", source: "walkin" });
    expect(walkin.body.amount.advancePaise).toBe(0);
    expect(walkin.body.amount.balancePaise).toBe(walkin.body.amount.totalPaise);

    const block = await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["20:00", "21:00"],
        source: "block",
        note: "Maintenance",
      })
      .expect(201);
    expect(block.body.amount.totalPaise).toBe(0);
    await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["19:00"],
        source: "phone",
        customer,
      })
      .expect(409);
    await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["22:00"],
        source: "walkin",
      })
      .expect(400);

    // Online players now see those slots as taken.
    const player = await agent(ctx, "player@example.com");
    const online = await player.post("/v1/bookings/hold", {
      resourceId,
      date,
      startTimes: ["19:00"],
      customer,
    });
    expect(online.status).toBe(409);

    const cal = await owner.get(`/v1/venues/${venueId}/calendar?date=${date}`).expect(200);
    expect(cal.body.bookings.map((b: { source: string }) => b.source).sort()).toEqual([
      "block",
      "walkin",
    ]);
    expect(cal.body.bookings.find((b: { source: string }) => b.source === "block").note).toBe(
      "Maintenance",
    );
    expect(events.filter((e) => e.type === "created")).toHaveLength(2);

    const other = await agent(ctx, "other@example.com");
    await other.get(`/v1/venues/${venueId}/calendar?date=${date}`).expect(404);
    await other
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["06:00"],
        source: "block",
      })
      .expect(404);

    // Owner cancels the walk-in: slot frees up; owner refunds are always full.
    const cancelled = await owner.post(`/v1/bookings/${walkin.body.id}/cancel`, {}).expect(200);
    expect(cancelled.body.cancellation.by).toBe("owner");
    await player
      .post("/v1/bookings/hold", { resourceId, date, startTimes: ["19:00"], customer })
      .expect(201);
  });

  it("marks balance collected, and no-show/completed only after start", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${venueId}/resources`)).body[0].id;
    const date = bookableDates()[1]!;
    const b = await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["07:00"],
        source: "phone",
        customer,
      })
      .expect(201);
    const paid = await owner
      .post(`/v1/bookings/${b.body.id}/balance`, { method: "upi" })
      .expect(200);
    expect(paid.body.balanceCollected.method).toBe("upi");
    await owner.post(`/v1/bookings/${b.body.id}/no-show`).expect(409);

    ctx.clock.offsetMs = 2 * 86_400_000; // two days later
    const done = await owner.post(`/v1/bookings/${b.body.id}/complete`).expect(200);
    expect(done.body.status).toBe("completed");
    const player = await agent(ctx, "player@example.com");
    await player.post(`/v1/bookings/${b.body.id}/balance`, { method: "cash" }).expect(404);
  });

  it("auto-completes confirmed bookings after their end time", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${venueId}/resources`)).body[0].id;
    const date = bookableDates()[1]!;
    const b = await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["07:00"],
        source: "walkin",
        customer,
      })
      .expect(201);
    expect(await ctx.bookings.completeFinished()).toBe(0);
    ctx.clock.offsetMs = 3 * 86_400_000;
    expect(await ctx.bookings.completeFinished()).toBe(1);
    expect((await BookingModel.findById(b.body.id))?.status).toBe("completed");
  });
});
