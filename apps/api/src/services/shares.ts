import { randomBytes } from "node:crypto";
import {
  GAME_JOIN_CUTOFF_MINUTES,
  HOLD_MINUTES,
  addDays,
  convenienceFeePaise,
  formatPaise,
  istDate,
  splitPaise,
  type BookingShares,
  type Game,
  type GameCard,
  type OpenGameRequest,
  type SharePage,
  type SplitRequest,
  type Sport,
} from "@townplay/shared";
import type { Logger } from "pino";
import { Types } from "mongoose";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BookingModel, type BookingRaw } from "../models/booking.js";
import { BookingShareModel, type BookingShareRaw } from "../models/bookingShare.js";
import { CityModel } from "../models/city.js";
import { OpenGameModel, type OpenGameRaw } from "../models/openGame.js";
import { ResourceModel } from "../models/resource.js";
import { UserModel } from "../models/user.js";
import { VenueModel } from "../models/venue.js";
import type { RefundStatus } from "./bookings.js";
import type { EmailSender } from "./email.js";
import { loadOwnedVenue } from "./listings.js";
import type { SettingsService } from "./settings.js";

const oid = (id: string) => new Types.ObjectId(id);
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export interface ShareRefunder {
  refundShare(shareId: Types.ObjectId, amountPaise: number, reason: string): Promise<RefundStatus>;
}

/** Sum of shares paid online towards a booking's venue balance (refunded ones excluded). */
export async function sharesPaidFor(bookingIds: Types.ObjectId[]): Promise<Map<string, number>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await BookingShareModel.aggregate<{ _id: Types.ObjectId; total: number }>([
    { $match: { bookingId: { $in: bookingIds }, status: "paid" } },
    { $group: { _id: "$bookingId", total: { $sum: "$amountPaise" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.total]));
}

export function createShareService(deps: {
  settings: SettingsService;
  email: EmailSender;
  logger: Logger;
  webOrigin: string;
  now?: () => Date;
}) {
  const { settings, email, logger, webOrigin, now = () => new Date() } = deps;
  let refunder: ShareRefunder | undefined;

  async function mail(userId: Types.ObjectId | null | undefined, subject: string, text: string) {
    if (!userId) return;
    try {
      const user = await UserModel.findById(userId, { email: 1 }).lean();
      if (user?.email) await email.send({ to: user.email, subject, text });
    } catch (err) {
      logger.error({ err, subject }, "share email failed");
    }
  }

  async function ownBookingForSharing(user: AuthUser, bookingId: string) {
    const booking = await BookingModel.findById(bookingId);
    if (!booking || String(booking.userId) !== user.id) throw notFound("Booking");
    if (booking.source !== "online" || booking.status !== "confirmed") {
      throw new HttpError(409, "CONFLICT", "Only confirmed online bookings can be shared");
    }
    if (booking.openGameId || booking.split)
      throw new HttpError(409, "CONFLICT", "This booking is already shared");
    return booking;
  }

  async function balanceDue(booking: Pick<BookingRaw, "_id" | "amount">) {
    const paid = (await sharesPaidFor([booking._id])).get(String(booking._id)) ?? 0;
    return Math.max(0, booking.amount.balancePaise - paid);
  }

  // ---------- open games ----------

  async function openGame(user: AuthUser, bookingId: string, req: OpenGameRequest) {
    const booking = await ownBookingForSharing(user, bookingId);
    const cutoff = new Date(booking.startsAt.getTime() - GAME_JOIN_CUTOFF_MINUTES * 60_000);
    if (cutoff <= now())
      throw new HttpError(409, "CONFLICT", "Too close to the start to open this game");
    if (req.pricePerHeadPaise * req.spotsNeeded > (await balanceDue(booking))) {
      throw new HttpError(
        400,
        "VALIDATION_FAILED",
        "Players would pay more than the balance due at the venue",
      );
    }
    const [venue, resource, host] = await Promise.all([
      VenueModel.findById(booking.venueId, { cityId: 1, citySlug: 1 }).lean(),
      ResourceModel.findById(booking.resourceId, { sport: 1 }).lean(),
      UserModel.findById(user.id, { name: 1 }).lean(),
    ]);
    if (!venue || !resource) throw notFound("Venue");
    const game = await OpenGameModel.create({
      bookingId: booking._id,
      hostUserId: oid(user.id),
      hostFirstName: firstName(booking.customer?.name || host?.name || "Host"),
      businessId: booking.businessId,
      venueId: booking.venueId,
      resourceId: booking.resourceId,
      cityId: venue.cityId,
      citySlug: venue.citySlug,
      sport: resource.sport,
      skillLevel: req.skillLevel,
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      startsAt: booking.startsAt,
      joinCutoffAt: cutoff,
      totalSpots: req.spotsNeeded,
      pricePerHeadPaise: req.pricePerHeadPaise,
      note: req.note,
    });
    booking.openGameId = game._id;
    await booking.save();
    return game;
  }

  async function toCards(games: OpenGameRaw[]): Promise<GameCard[]> {
    const venues = await VenueModel.find(
      { _id: { $in: games.map((g) => g.venueId) } },
      { name: 1, area: 1 },
    ).lean();
    const byId = new Map(venues.map((v) => [String(v._id), v]));
    return games.map((g) => ({
      id: String(g._id),
      sport: g.sport,
      skillLevel: g.skillLevel,
      venueName: byId.get(String(g.venueId))?.name ?? "",
      area: byId.get(String(g.venueId))?.area ?? "",
      date: g.date,
      startTime: g.startTime,
      endTime: g.endTime,
      spotsLeft: Math.max(0, g.totalSpots - g.filledSpots),
      totalSpots: g.totalSpots,
      pricePerHeadPaise: g.pricePerHeadPaise,
      hostFirstName: g.hostFirstName,
      status: g.status,
    }));
  }

  async function listGames(
    citySlug: string,
    q: { day: "today" | "tomorrow" | "all"; sport?: string | undefined },
  ) {
    const city = await CityModel.findOne({ slug: citySlug, isActive: true }).lean();
    if (!city) throw notFound("City");
    const today = istDate(now());
    const dates =
      q.day === "today" ? [today] : q.day === "tomorrow" ? [addDays(today, 1)] : undefined;
    const games = await OpenGameModel.find({
      cityId: city._id,
      status: { $in: ["open", "full"] },
      joinCutoffAt: { $gt: now() },
      ...(dates ? { date: { $in: dates } } : {}),
      ...(q.sport ? { sport: q.sport as Sport } : {}),
    })
      .sort({ startsAt: 1 })
      .limit(100)
      .lean();
    return toCards(games);
  }

  async function getGame(viewer: AuthUser | undefined, gameId: string): Promise<Game> {
    const game = await OpenGameModel.findById(gameId).lean();
    if (!game) throw notFound("Game");
    const [card] = await toCards([game]);
    const [venue, resource] = await Promise.all([
      VenueModel.findById(game.venueId, { slug: 1, geo: 1 }).lean(),
      ResourceModel.findById(game.resourceId, { name: 1 }).lean(),
    ]);
    const isHost = viewer?.id === String(game.hostUserId);
    const shares = isHost
      ? await BookingShareModel.find({ gameId: game._id, status: { $in: ["held", "paid"] } })
          .sort({ createdAt: 1 })
          .lean()
      : [];
    const mine = viewer
      ? await BookingShareModel.findOne({ gameId: game._id, userId: oid(viewer.id) })
          .sort({ createdAt: -1 })
          .lean()
      : null;
    const [lng = 0, lat = 0] = venue?.geo?.coordinates ?? [];
    return {
      ...card!,
      bookingId: String(game.bookingId),
      citySlug: game.citySlug,
      venueSlug: venue?.slug ?? "",
      courtName: resource?.name ?? "",
      location: { lat, lng },
      note: game.note ?? null,
      joinCutoffAt: game.joinCutoffAt.toISOString(),
      startsAt: game.startsAt.toISOString(),
      players: isHost
        ? shares.map((s) => ({
            shareId: String(s._id),
            name: s.name,
            phone: s.phone ?? "",
            status: s.status,
          }))
        : null,
      myShare: mine
        ? {
            id: String(mine._id),
            status: mine.status,
            holdExpiresAt:
              mine.status === "held" ? (mine.holdExpiresAt?.toISOString() ?? null) : null,
          }
        : null,
      isHost,
    };
  }

  /** Takes one spot atomically; flips the game to full when the last spot goes. */
  async function takeSpot(gameId: Types.ObjectId): Promise<boolean> {
    const res = await OpenGameModel.updateOne(
      {
        _id: gameId,
        status: "open",
        joinCutoffAt: { $gt: now() },
        $expr: { $lt: ["$filledSpots", "$totalSpots"] },
      },
      { $inc: { filledSpots: 1 } },
    );
    if (res.modifiedCount !== 1) return false;
    await OpenGameModel.updateOne(
      { _id: gameId, status: "open", $expr: { $gte: ["$filledSpots", "$totalSpots"] } },
      { $set: { status: "full" } },
    );
    return true;
  }

  async function releaseSpot(gameId: Types.ObjectId) {
    await OpenGameModel.updateOne(
      { _id: gameId, filledSpots: { $gt: 0 } },
      { $inc: { filledSpots: -1 } },
    );
    await OpenGameModel.updateOne(
      { _id: gameId, status: "full", $expr: { $lt: ["$filledSpots", "$totalSpots"] } },
      { $set: { status: "open" } },
    );
  }

  async function join(user: AuthUser, gameId: string, input: { name: string; phone: string }) {
    const game = await OpenGameModel.findById(gameId).lean();
    if (!game) throw notFound("Game");
    if (String(game.hostUserId) === user.id)
      throw new HttpError(409, "CONFLICT", "You are hosting this game");
    if (game.joinCutoffAt <= now() || !["open", "full"].includes(game.status)) {
      throw new HttpError(409, "GAME_CLOSED", "Joining has closed for this game");
    }
    if (!(await takeSpot(game._id))) throw new HttpError(409, "GAME_FULL", "This game is full");
    const fee = convenienceFeePaise(game.pricePerHeadPaise, (await settings.get()).convenienceFee);
    const free = game.pricePerHeadPaise + fee === 0;
    try {
      const share = await BookingShareModel.create({
        bookingId: game.bookingId,
        businessId: game.businessId,
        kind: "game",
        gameId: game._id,
        userId: oid(user.id),
        name: input.name,
        phone: input.phone,
        amountPaise: game.pricePerHeadPaise,
        feePaise: fee,
        status: free ? "paid" : "held",
        activeKey: `${gameId}:${user.id}`,
        ...(free
          ? { paidAt: now() }
          : { holdExpiresAt: new Date(now().getTime() + HOLD_MINUTES * 60_000) }),
      });
      if (free) await notifyHostJoined(game, input.name);
      return share;
    } catch (err) {
      await releaseSpot(game._id);
      if (typeof err === "object" && err && "code" in err && err.code === 11000) {
        throw new HttpError(409, "ALREADY_JOINED", "You have already joined this game");
      }
      throw err;
    }
  }

  async function notifyHostJoined(
    game: Pick<OpenGameRaw, "hostUserId" | "_id" | "date" | "startTime">,
    name: string,
  ) {
    await mail(
      game.hostUserId,
      `${name} joined your game (${game.date} ${game.startTime})`,
      `${name} joined your open game on ${game.date} at ${game.startTime}.\n${webOrigin}/games/${String(game._id)}`,
    );
  }

  async function leave(user: AuthUser, gameId: string) {
    const share = await BookingShareModel.findOne({
      gameId: oid(gameId),
      userId: oid(user.id),
      status: { $in: ["held", "paid"] },
    });
    if (!share) throw notFound("Spot");
    const game = await OpenGameModel.findById(gameId).lean();
    if (!game || game.joinCutoffAt <= now())
      throw new HttpError(409, "GAME_CLOSED", "It is too late to leave this game");
    const wasPaid = share.status === "paid";
    const res = await BookingShareModel.updateOne(
      { _id: share._id, status: share.status },
      {
        $set: { status: wasPaid ? "refunded" : "cancelled" },
        $unset: { activeKey: 1, holdExpiresAt: 1 },
      },
    );
    if (res.modifiedCount !== 1) throw new HttpError(409, "CONFLICT", "Try again");
    await releaseSpot(game._id);
    // Leaving voluntarily: the share is refunded, the convenience fee is kept.
    if (wasPaid && share.amountPaise > 0 && refunder) {
      await refunder.refundShare(share._id, share.amountPaise, "Left the game");
      await BookingShareModel.updateOne(
        { _id: share._id },
        { $set: { refundPaise: share.amountPaise } },
      );
    }
  }

  async function loadHostGame(user: AuthUser, gameId: string) {
    const game = await OpenGameModel.findById(gameId);
    if (!game) throw notFound("Game");
    if (String(game.hostUserId) !== user.id) {
      try {
        await loadOwnedVenue(user, String(game.venueId));
      } catch {
        throw notFound("Game");
      }
    }
    return game;
  }

  /** Refunds every paid share of a game in full (fee included) and cancels held ones. */
  async function refundAllShares(filter: Record<string, unknown>, reason: string) {
    await BookingShareModel.updateMany(
      { ...filter, status: { $in: ["held", "pending"] } },
      { $set: { status: "cancelled" }, $unset: { activeKey: 1, holdExpiresAt: 1 } },
    );
    const paid = await BookingShareModel.find({ ...filter, status: "paid" });
    for (const share of paid) {
      const amount = share.amountPaise + share.feePaise;
      share.status = "refunded";
      share.set("activeKey", undefined);
      share.refundPaise = amount;
      await share.save();
      if (amount > 0 && refunder) {
        try {
          await refunder.refundShare(share._id, amount, reason);
        } catch (err) {
          logger.error({ err, shareId: String(share._id) }, "share refund failed");
        }
      }
      await mail(
        share.userId,
        `Refund: ${reason}`,
        `${reason}. Your payment of ${formatPaise(amount)} is being refunded.`,
      );
    }
  }

  async function cancelGame(user: AuthUser, gameId: string) {
    const game = await loadHostGame(user, gameId);
    if (["cancelled", "completed"].includes(game.status))
      throw new HttpError(409, "CONFLICT", `Game is ${game.status}`);
    game.status = "cancelled";
    await game.save();
    await refundAllShares({ gameId: game._id }, "The host cancelled the open game");
    return game;
  }

  /** After the cutoff the host decides to play with whoever joined. */
  async function keepGame(user: AuthUser, gameId: string) {
    const game = await loadHostGame(user, gameId);
    if (!["open", "full"].includes(game.status))
      throw new HttpError(409, "CONFLICT", `Game is ${game.status}`);
    game.status = "closed";
    await game.save();
    return game;
  }

  // ---------- split payments ----------

  async function createSplit(user: AuthUser, bookingId: string, req: SplitRequest) {
    const booking = await ownBookingForSharing(user, bookingId);
    if (booking.startsAt <= now()) throw new HttpError(409, "CONFLICT", "This booking has started");
    const due = await balanceDue(booking);
    if (due <= 0) throw new HttpError(409, "CONFLICT", "Nothing left to split");
    const amounts = splitPaise(due, req.shares.length);
    const fee = (await settings.get()).convenienceFee;
    await BookingShareModel.insertMany(
      req.shares.map((s, i) => ({
        bookingId: booking._id,
        businessId: booking.businessId,
        kind: "split",
        name: s.name,
        ...(s.phone ? { phone: s.phone } : {}),
        amountPaise: amounts[i],
        feePaise: convenienceFeePaise(amounts[i]!, fee),
        status: "pending",
        token: randomBytes(18).toString("base64url"),
      })),
    );
    booking.split = true;
    await booking.save();
    return sharesOf(user, bookingId);
  }

  async function sharesOf(user: AuthUser, bookingId: string): Promise<BookingShares> {
    const booking = await BookingModel.findById(bookingId).lean();
    if (!booking) throw notFound("Booking");
    if (String(booking.userId) !== user.id) {
      try {
        await loadOwnedVenue(user, String(booking.venueId));
      } catch {
        throw notFound("Booking");
      }
    }
    const shares = await BookingShareModel.find({
      bookingId: booking._id,
      status: { $ne: "expired" },
    })
      .sort({ createdAt: 1 })
      .lean();
    const paid = shares
      .filter((s) => s.status === "paid")
      .reduce((sum, s) => sum + s.amountPaise, 0);
    const organiser = String(booking.userId) === user.id;
    return {
      bookingId,
      balancePaise: booking.amount.balancePaise,
      sharesPaidPaise: paid,
      balanceDuePaise: Math.max(0, booking.amount.balancePaise - paid),
      openGameId: booking.openGameId ? String(booking.openGameId) : null,
      shares: shares.map((s) => ({
        id: String(s._id),
        kind: s.kind,
        name: s.name,
        amountPaise: s.amountPaise,
        feePaise: s.feePaise,
        status: s.status,
        token: organiser && s.kind === "split" ? (s.token ?? null) : null,
        paidAt: s.paidAt?.toISOString() ?? null,
      })),
    };
  }

  async function sharePage(token: string): Promise<SharePage> {
    const share = await BookingShareModel.findOne({ token, kind: "split" }).lean();
    if (!share) throw notFound("Share");
    const booking = await BookingModel.findById(share.bookingId).lean();
    if (!booking) throw notFound("Share");
    const [venue, resource] = await Promise.all([
      VenueModel.findById(booking.venueId, { name: 1 }).lean(),
      ResourceModel.findById(booking.resourceId, { name: 1 }).lean(),
    ]);
    return {
      id: String(share._id),
      name: share.name,
      amountPaise: share.amountPaise,
      feePaise: share.feePaise,
      status:
        booking.status === "cancelled" && share.status === "pending" ? "cancelled" : share.status,
      organiserFirstName: firstName(booking.customer?.name ?? ""),
      venueName: venue?.name ?? "",
      courtName: resource?.name ?? "",
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      deadline: booking.startsAt.toISOString(),
    };
  }

  // ---------- payment hooks ----------

  /** Whether a share can be paid now by this user (payments service). */
  async function payable(
    user: AuthUser,
    shareId: string,
    viaToken: boolean,
  ): Promise<BookingShareRaw> {
    const share = await BookingShareModel.findById(shareId).lean();
    if (!share) throw notFound("Share");
    const at = now();
    if (share.kind === "game") {
      if (String(share.userId) !== user.id) throw notFound("Share");
      if (share.status !== "held" || !share.holdExpiresAt || share.holdExpiresAt <= at) {
        throw new HttpError(409, "HOLD_EXPIRED", "Your spot hold has expired. Join again.");
      }
    } else {
      if (!viaToken) throw notFound("Share");
      const booking = await BookingModel.findById(share.bookingId, {
        status: 1,
        startsAt: 1,
      }).lean();
      if (share.status !== "pending" || booking?.status !== "confirmed" || booking.startsAt <= at) {
        throw new HttpError(409, "CONFLICT", "This share can no longer be paid");
      }
    }
    return share;
  }

  /** Payment captured for a share. A game spot whose hold expired re-takes a spot if one is free. */
  async function confirmPaid(
    shareId: string,
    payerId: string | null,
  ): Promise<"confirmed" | "already" | "conflict"> {
    const share = await BookingShareModel.findById(shareId).lean();
    if (!share) throw notFound("Share");
    if (share.status === "paid") return "already";
    const at = now();
    const set = { status: "paid", paidAt: at, ...(payerId ? { userId: oid(payerId) } : {}) };
    if (share.status === "held" || share.status === "pending") {
      const res = await BookingShareModel.updateOne(
        { _id: share._id, status: share.status },
        { $set: set, $unset: { holdExpiresAt: 1 } },
      );
      if (res.modifiedCount === 1) {
        if (share.gameId) {
          const game = await OpenGameModel.findById(share.gameId, {
            hostUserId: 1,
            date: 1,
            startTime: 1,
          }).lean();
          if (game) await notifyHostJoined(game, share.name);
        }
        return "confirmed";
      }
      return confirmPaid(shareId, payerId);
    }
    if (share.status === "expired" && share.gameId && (await takeSpot(share.gameId))) {
      try {
        const res = await BookingShareModel.updateOne(
          { _id: share._id, status: "expired" },
          { $set: { ...set, activeKey: `${String(share.gameId)}:${String(share.userId)}` } },
        );
        if (res.modifiedCount === 1) return "confirmed";
      } catch {
        // already re-joined with another share
      }
      await releaseSpot(share.gameId);
    }
    return "conflict";
  }

  /** Paid but cannot be honoured (game full / cancelled): refund everything paid. */
  async function systemRefund(shareId: string, reason: string) {
    const share = await BookingShareModel.findById(shareId);
    if (!share) return;
    const amount = share.amountPaise + share.feePaise;
    share.status = "refunded";
    share.refundPaise = amount;
    share.set("activeKey", undefined);
    await share.save();
    if (refunder && amount > 0) await refunder.refundShare(share._id, amount, reason);
  }

  /** The booking was cancelled: every share is refunded in full. */
  async function onBookingCancelled(bookingId: Types.ObjectId) {
    await OpenGameModel.updateOne(
      { bookingId, status: { $nin: ["completed"] } },
      { $set: { status: "cancelled" } },
    );
    await refundAllShares({ bookingId }, "The booking was cancelled");
  }

  // ---------- jobs ----------

  async function expireHolds(): Promise<number> {
    const stale = await BookingShareModel.find({
      kind: "game",
      status: "held",
      holdExpiresAt: { $lte: now() },
    }).lean();
    let n = 0;
    for (const s of stale) {
      const res = await BookingShareModel.updateOne(
        { _id: s._id, status: "held" },
        { $set: { status: "expired" }, $unset: { activeKey: 1 } },
      );
      if (res.modifiedCount === 1 && s.gameId) {
        await releaseSpot(s.gameId);
        n++;
      }
    }
    return n;
  }

  /** Cutoff: tell hosts of games that did not fill up to keep or cancel. Start: complete games, expire unpaid split shares. */
  async function cutoffs(): Promise<void> {
    const at = now();
    const due = await OpenGameModel.find({
      status: "open",
      joinCutoffAt: { $lte: at },
      cutoffNotifiedAt: { $exists: false },
    }).lean();
    for (const g of due) {
      const claimed = await OpenGameModel.updateOne(
        { _id: g._id, cutoffNotifiedAt: { $exists: false } },
        { $set: { cutoffNotifiedAt: at } },
      );
      if (claimed.modifiedCount !== 1) continue;
      await mail(
        g.hostUserId,
        `Your open game is not full (${g.filledSpots}/${g.totalSpots})`,
        `Joining has closed for your game on ${g.date} at ${g.startTime}. Keep it with the players who joined, or cancel to refund them:\n${webOrigin}/games/${String(g._id)}`,
      );
    }
    await OpenGameModel.updateMany(
      { status: { $in: ["open", "full", "closed"] }, startsAt: { $lte: at } },
      { $set: { status: "completed" } },
    );
    const started = await BookingModel.find(
      { split: true, startsAt: { $lte: at } },
      { _id: 1 },
    ).lean();
    if (started.length) {
      // Unpaid split shares fall to the organiser at the venue.
      await BookingShareModel.updateMany(
        { bookingId: { $in: started.map((b) => b._id) }, kind: "split", status: "pending" },
        { $set: { status: "expired" } },
      );
    }
  }

  return {
    setRefunder: (r: ShareRefunder) => {
      refunder = r;
    },
    openGame,
    listGames,
    getGame,
    join,
    leave,
    cancelGame,
    keepGame,
    createSplit,
    sharesOf,
    sharePage,
    payable,
    confirmPaid,
    systemRefund,
    onBookingCancelled,
    expireHolds,
    cutoffs,
  };
}

export type ShareService = ReturnType<typeof createShareService>;
