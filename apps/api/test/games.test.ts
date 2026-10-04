import { bookableDates } from "@townplay/shared";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { BookingShareModel } from "../src/models/bookingShare.js";
import { OpenGameModel } from "../src/models/openGame.js";
import { seed } from "../src/scripts/seed.js";
import { adminAgent, agent, liveVenue, payHold } from "./factories.js";
import { setupApp } from "./helpers.js";

const customer = { name: "Rahul Verma", phone: "9876543210" };
type Ctx = ReturnType<typeof setupApp>;

/** A live venue and a confirmed, paid online booking by `host` (two 1-hour slots, 3 days out). */
async function hostedBooking(ctx: Ctx) {
  const owner = await agent(ctx, "owner@example.com");
  const ids = await liveVenue(ctx, owner);
  const resourceId = (await owner.get(`/v1/venues/${ids.venueId}/resources`)).body[0].id as string;
  const host = await agent(ctx, "host@example.com");
  const date = bookableDates()[3]!;
  const hold = await host
    .post("/v1/bookings/hold", { resourceId, date, startTimes: ["18:00", "19:00"], customer })
    .expect(201);
  await payHold(host, hold.body.id);
  return { owner, host, booking: hold.body, ...ids };
}

async function paySpot(player: Awaited<ReturnType<typeof agent>>, shareId: string) {
  const order = await player.post("/v1/payments/orders", { shareId }).expect(201);
  return player.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);
}

describe("open games", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("host opens a game; players see it, join and pay; host sees players; balance due drops", async () => {
    const { host, booking } = await hostedBooking(ctx);
    const tooMuch = await host.post(`/v1/bookings/${booking.id}/open-game`, {
      skillLevel: "any",
      spotsNeeded: 30,
      pricePerHeadPaise: booking.amount.balancePaise,
    });
    expect(tooMuch.status).toBe(400);
    const game = await host
      .post(`/v1/bookings/${booking.id}/open-game`, {
        skillLevel: "intermediate",
        spotsNeeded: 4,
        pricePerHeadPaise: 15000,
      })
      .expect(201);
    expect(game.body).toMatchObject({
      spotsLeft: 4,
      isHost: true,
      hostFirstName: "Rahul",
      status: "open",
    });
    await host
      .post(`/v1/bookings/${booking.id}/open-game`, {
        skillLevel: "any",
        spotsNeeded: 1,
        pricePerHeadPaise: 0,
      })
      .expect(409);

    const list = await request(ctx.app).get("/v1/cities/bareilly/games").expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: game.body.id, spotsLeft: 4, sport: "football" }),
    ]);
    const anon = await request(ctx.app).get(`/v1/games/${game.body.id}`).expect(200);
    expect(anon.body.players).toBeNull();

    const player = await agent(ctx, "player@example.com");
    const joined = await player
      .post(`/v1/games/${game.body.id}/join`, { name: "Amit", phone: "9123456780" })
      .expect(201);
    expect(joined.body.myShare).toMatchObject({ status: "held" });
    await player
      .post(`/v1/games/${game.body.id}/join`, { name: "Amit", phone: "9123456780" })
      .expect(409);
    await paySpot(player, joined.body.myShare.id);

    const hostView = await host.get(`/v1/games/${game.body.id}`).expect(200);
    expect(hostView.body.players).toEqual([
      expect.objectContaining({ name: "Amit", status: "paid", phone: "9123456780" }),
    ]);
    const mine = await host.get(`/v1/bookings/${booking.id}`).expect(200);
    expect(mine.body).toMatchObject({
      sharesPaidPaise: 15000,
      balanceDuePaise: booking.amount.balancePaise - 15000,
    });
    expect(ctx.email.sent.some((m) => m.subject.startsWith("Amit joined your game"))).toBe(true);
  });

  it("parallel joins never overfill: 4 spots, 8 players → 4 in, game full", async () => {
    const { host, booking } = await hostedBooking(ctx);
    const game = await host
      .post(`/v1/bookings/${booking.id}/open-game`, {
        skillLevel: "any",
        spotsNeeded: 4,
        pricePerHeadPaise: 10000,
      })
      .expect(201);
    const players = await Promise.all(
      Array.from({ length: 8 }, (_, i) => agent(ctx, `p${i}@example.com`)),
    );
    const results = await Promise.all(
      players.map((p, i) =>
        p.post(`/v1/games/${game.body.id}/join`, { name: `P${i}`, phone: "9123456780" }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.error.code === "GAME_FULL"),
    ).toBe(true);
    const doc = await OpenGameModel.findById(game.body.id).lean();
    expect(doc).toMatchObject({ filledSpots: 4, status: "full" });
  });

  it("expired spot holds and leaving reopen the game; leaving refunds the share (fee kept)", async () => {
    const { host, booking } = await hostedBooking(ctx);
    const admin = await adminAgent(ctx);
    await admin
      .put("/v1/admin/settings", { convenienceFee: { flatPaise: 500, percent: 0 } })
      .expect(200);
    const game = await host
      .post(`/v1/bookings/${booking.id}/open-game`, {
        skillLevel: "any",
        spotsNeeded: 1,
        pricePerHeadPaise: 10000,
      })
      .expect(201);
    const a = await agent(ctx, "a@example.com");
    await a
      .post(`/v1/games/${game.body.id}/join`, { name: "Anil", phone: "9123456780" })
      .expect(201);
    const b = await agent(ctx, "b@example.com");
    await b
      .post(`/v1/games/${game.body.id}/join`, { name: "Bina", phone: "9123456781" })
      .expect(409);

    ctx.clock.offsetMs = 11 * 60_000;
    expect(await ctx.services.shares.expireHolds()).toBe(1);
    const bJoin = await b
      .post(`/v1/games/${game.body.id}/join`, { name: "Bina", phone: "9123456781" })
      .expect(201);
    await paySpot(b, bJoin.body.myShare.id);
    await b.post(`/v1/games/${game.body.id}/leave`).expect(200);
    expect(ctx.gateway.refunds).toEqual([expect.objectContaining({ amountPaise: 10000 })]);
    expect((await OpenGameModel.findById(game.body.id).lean())?.status).toBe("open");
  });

  it("host cancels the game: paid players get everything back", async () => {
    const { host, booking } = await hostedBooking(ctx);
    const game = await host
      .post(`/v1/bookings/${booking.id}/open-game`, {
        skillLevel: "any",
        spotsNeeded: 2,
        pricePerHeadPaise: 12000,
      })
      .expect(201);
    const p = await agent(ctx, "p@example.com");
    const joined = await p
      .post(`/v1/games/${game.body.id}/join`, { name: "Pooja", phone: "9123456780" })
      .expect(201);
    await paySpot(p, joined.body.myShare.id);
    const stranger = await agent(ctx, "s@example.com");
    await stranger.post(`/v1/games/${game.body.id}/cancel`).expect(404);
    await host.post(`/v1/games/${game.body.id}/cancel`).expect(200);
    expect(ctx.gateway.refunds).toEqual([expect.objectContaining({ amountPaise: 12000 })]);
    expect((await BookingShareModel.findById(joined.body.myShare.id).lean())?.status).toBe(
      "refunded",
    );
  });

  it("after the cutoff the host is asked to keep or cancel an unfilled game", async () => {
    const { host, booking } = await hostedBooking(ctx);
    const game = await host
      .post(`/v1/bookings/${booking.id}/open-game`, {
        skillLevel: "any",
        spotsNeeded: 3,
        pricePerHeadPaise: 0,
      })
      .expect(201);
    const p = await agent(ctx, "p@example.com");
    await p
      .post(`/v1/games/${game.body.id}/join`, { name: "Pooja", phone: "9123456780" })
      .expect(201);
    ctx.clock.offsetMs = Date.parse(game.body.joinCutoffAt) - Date.now() + 60_000;
    await p
      .post(`/v1/games/${game.body.id}/join`, { name: "Pooja", phone: "9123456780" })
      .expect(409);
    await ctx.services.shares.cutoffs();
    await ctx.services.shares.cutoffs();
    expect(
      ctx.email.sent.filter((m) => m.subject.startsWith("Your open game is not full")),
    ).toHaveLength(1);
    const kept = await host.post(`/v1/games/${game.body.id}/keep`).expect(200);
    expect(kept.body.status).toBe("closed");
  });
});

describe("split payments", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("splits the balance into shares paid by friends through their links", async () => {
    const { host, booking, owner, businessId } = await hostedBooking(ctx);
    const split = await host
      .post(`/v1/bookings/${booking.id}/split`, {
        shares: [{ name: "Amit" }, { name: "Ravi", phone: "9123456780" }, { name: "Neha" }],
      })
      .expect(201);
    expect(split.body.shares).toHaveLength(3);
    const total = split.body.shares.reduce(
      (s: number, x: { amountPaise: number }) => s + x.amountPaise,
      0,
    );
    expect(total).toBe(booking.amount.balancePaise);
    const token = split.body.shares[0].token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const page = await request(ctx.app).get(`/v1/shares/${token}`).expect(200);
    expect(page.body).toMatchObject({
      name: "Amit",
      status: "pending",
      organiserFirstName: "Rahul",
    });
    const friend = await agent(ctx, "amit@example.com");
    await friend.post("/v1/payments/orders", { shareId: page.body.id }).expect(404); // needs the link
    const order = await friend.post(`/v1/shares/${token}/order`).expect(201);
    await friend.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);

    const shares = await host.get(`/v1/bookings/${booking.id}/shares`).expect(200);
    expect(shares.body.shares[0]).toMatchObject({ status: "paid" });
    expect(shares.body.balanceDuePaise).toBe(
      booking.amount.balancePaise - split.body.shares[0].amountPaise,
    );
    await host
      .post(`/v1/bookings/${booking.id}/split`, { shares: [{ name: "Xavier" }, { name: "Yash" }] })
      .expect(409);

    // Earnings reconcile: the share counts as collected online, the venue collects only the rest.
    await owner.post(`/v1/bookings/${booking.id}/balance`, { method: "cash" }).expect(200);
    const earnings = await owner
      .get(`/v1/businesses/${businessId}/earnings?from=${booking.date}&to=${booking.date}`)
      .expect(200);
    expect(earnings.body.advanceOnlinePaise).toBe(
      booking.amount.advancePaise + split.body.shares[0].amountPaise,
    );
    expect(earnings.body.balanceCollectedPaise).toBe(
      booking.amount.balancePaise - split.body.shares[0].amountPaise,
    );
  });

  it("owner cancelling the booking refunds paid shares; unpaid shares expire at the start", async () => {
    const { host, booking, owner } = await hostedBooking(ctx);
    const split = await host
      .post(`/v1/bookings/${booking.id}/split`, { shares: [{ name: "Amit" }, { name: "Ravi" }] })
      .expect(201);
    const friend = await agent(ctx, "amit@example.com");
    const order = await friend.post(`/v1/shares/${split.body.shares[0].token}/order`).expect(201);
    await friend.post("/v1/payments/fake-pay", { orderId: order.body.orderId }).expect(200);

    await owner.post(`/v1/bookings/${booking.id}/cancel`, { reason: "Pitch flooded" }).expect(200);
    const refunded = ctx.gateway.refunds.map((r) => r.amountPaise).sort((a, b) => a - b);
    expect(refunded).toContain(split.body.shares[0].amountPaise);
    const after = await request(ctx.app)
      .get(`/v1/shares/${split.body.shares[1].token}`)
      .expect(200);
    expect(after.body.status).toBe("cancelled");
    await friend.post(`/v1/shares/${split.body.shares[1].token}/order`).expect(409);
  });
});
