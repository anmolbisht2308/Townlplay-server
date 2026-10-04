import {
  HOLD_MINUTES,
  PAST_BUFFER_MINUTES,
  areConsecutive,
  bookableDates,
  bookingAmount,
  generateSlots,
  istToUtc,
  memberPricePaise,
  paidOnlinePaise,
  refundPaise,
  type Booking,
  type BookingStatus,
  type CancelledBy,
  type BookingEvent,
  type Calendar,
  type HoldRequest,
  type OwnerBookingRequest,
  type ResourceAvailability,
  type Slot,
  type VenueAvailability,
} from "@townplay/shared";
import mongoose, { Types } from "mongoose";
import { bookingCode } from "../lib/bookingCode.js";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BookingModel, type BookingDoc, type BookingRaw } from "../models/booking.js";
import { BusinessModel } from "../models/business.js";
import type { CoachingBatchRaw } from "../models/coachingBatch.js";
import { MembershipModel } from "../models/membership.js";
import { MembershipPlanModel } from "../models/membershipPlan.js";
import { ResourceModel, type ResourceRaw } from "../models/resource.js";
import { SlotLockModel } from "../models/slotLock.js";
import { VenueModel, type VenueRaw } from "../models/venue.js";
import { audit } from "./audit.js";
import type { BookingEventBus } from "./bookingEvents.js";
import type { Notifier } from "./notify.js";
import type { SettingsService } from "./settings.js";
import { loadOwnedVenue } from "./listings.js";
import { sharesPaidFor } from "./shares.js";

const oid = (id: string) => new Types.ObjectId(id);
const ACTIVE = ["pending_payment", "confirmed"] as const;

function dupKeyOn(err: unknown, collection: string): boolean {
  if (typeof err !== "object" || err === null || !("code" in err) || err.code !== 11000)
    return false;
  return (
    "message" in err && typeof err.message === "string" && err.message.includes(`${collection} `)
  );
}

const slotTaken = () =>
  new HttpError(409, "SLOT_TAKEN", "One of these slots was just booked. Pick another time.");

export type RefundStatus = "none" | "pending" | "processed" | "failed";

/** Executes refunds through the payment gateway (payments service); bound after creation. */
export interface Refunder {
  refundBooking(
    bookingId: Types.ObjectId,
    amountPaise: number,
    reason: string,
  ): Promise<RefundStatus>;
}

export interface BookingServiceDeps {
  events: BookingEventBus;
  notifier: Notifier;
  settings: SettingsService;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createBookingService({
  events,
  notifier,
  settings,
  now = () => new Date(),
}: BookingServiceDeps) {
  let refunder: Refunder | undefined;
  function setRefunder(r: Refunder) {
    refunder = r;
  }
  /** Open-game spots and split shares of a cancelled booking are refunded (shares service). */
  let onCancelled: ((bookingId: Types.ObjectId) => Promise<void>) | undefined;
  function setOnCancelled(fn: (bookingId: Types.ObjectId) => Promise<void>) {
    onCancelled = fn;
  }
  // ---------- loading ----------

  async function liveVenue(venueId: Types.ObjectId | string): Promise<VenueRaw> {
    const venue = await VenueModel.findOne({
      _id: venueId,
      status: "live",
      businessActive: true,
    }).lean();
    if (!venue) throw notFound("Venue");
    return venue;
  }

  async function activeResource(resourceId: string): Promise<ResourceRaw> {
    const resource = await ResourceModel.findOne({ _id: oid(resourceId), isActive: true }).lean();
    if (!resource) throw notFound("Court");
    return resource;
  }

  function assertBookableDate(date: string) {
    if (!bookableDates(now()).includes(date)) {
      throw new HttpError(400, "DATE_OUT_OF_RANGE", "Pick a date within the next 14 days");
    }
  }

  // ---------- availability ----------

  async function slotsFor(
    venue: VenueRaw,
    resource: ResourceRaw,
    date: string,
    mode: "online" | "owner",
  ): Promise<Slot[]> {
    const at = now();
    const hours = venue.openingHours.map((d) => ({
      open: d.open,
      close: d.close,
      closed: Boolean(d.closed),
    }));
    const generated = generateSlots(hours, resource.slotDurationMins, resource.pricingRules, date);
    // Locks past their expiresAt are free even if the TTL monitor has not removed them yet.
    const locks = await SlotLockModel.find(
      {
        resourceId: resource._id,
        date,
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: at } }],
      },
      { startTime: 1 },
    ).lean();
    const taken = new Set(locks.map((l) => l.startTime));
    const pastBefore = at.getTime() + (mode === "online" ? PAST_BUFFER_MINUTES * 60_000 : 0);
    return generated.map((s): Slot => {
      const boundary =
        mode === "online"
          ? istToUtc(date, s.startTime)
          : istToUtc(date, s.endTime === "24:00" ? "23:59" : s.endTime);
      let status: Slot["status"] = "available";
      if (taken.has(s.startTime)) status = "taken";
      else if (boundary.getTime() < pastBefore) status = "past";
      else if (s.pricePaise === null) status = "unpriced";
      return { ...s, status };
    });
  }

  async function availabilityOf(
    venue: VenueRaw,
    resources: ResourceRaw[],
    date: string,
    mode: "online" | "owner",
  ): Promise<ResourceAvailability[]> {
    return Promise.all(
      resources.map(async (r) => ({
        resourceId: String(r._id),
        name: r.name,
        sport: r.sport,
        slotDurationMins: r.slotDurationMins,
        slots: await slotsFor(venue, r, date, mode),
      })),
    );
  }

  async function venueAvailability(venueId: string, date: string): Promise<VenueAvailability> {
    assertBookableDate(date);
    const venue = await liveVenue(venueId);
    const resources = await ResourceModel.find({ venueId: venue._id, isActive: true })
      .sort({ name: 1 })
      .lean();
    return { venueId, date, resources: await availabilityOf(venue, resources, date, "online") };
  }

  async function resourceAvailability(
    resourceId: string,
    date: string,
  ): Promise<ResourceAvailability> {
    assertBookableDate(date);
    const resource = await activeResource(resourceId);
    const venue = await liveVenue(resource.venueId);
    const [availability] = await availabilityOf(venue, [resource], date, "online");
    return availability!;
  }

  /**
   * The player's active membership plan at this venue on that date, if it still has a discounted
   * booking left this month. (The monthly cap is checked, not locked: two bookings made in the
   * same second may both get the discount.)
   */
  async function memberDiscountFor(userId: string, venueId: Types.ObjectId, date: string) {
    const memberships = await MembershipModel.find({
      userId: oid(userId),
      venueId,
      kind: "plan",
      status: "active",
      startsOn: { $lte: date },
      endsOn: { $gte: date },
    }).lean();
    if (memberships.length === 0) return null;
    const plans = await MembershipPlanModel.find({
      _id: { $in: memberships.map((m) => m.planId) },
    }).lean();
    const month = date.slice(0, 7);
    let best: { membershipId: Types.ObjectId; discountPercent: number } | null = null;
    for (const m of memberships) {
      const plan = plans.find((p) => String(p._id) === String(m.planId));
      if (!plan || plan.discountPercent <= 0) continue;
      if (plan.bookingsPerMonth !== null && plan.bookingsPerMonth !== undefined) {
        const used = await bookingsUsed(m._id, month);
        if (used >= plan.bookingsPerMonth) continue;
      }
      if (!best || plan.discountPercent > best.discountPercent)
        best = { membershipId: m._id, discountPercent: plan.discountPercent };
    }
    return best;
  }

  /** Discounted bookings of a membership in a calendar month ("YYYY-MM"). */
  async function bookingsUsed(membershipId: Types.ObjectId, month: string): Promise<number> {
    return BookingModel.countDocuments({
      membershipId,
      date: { $gte: `${month}-01`, $lte: `${month}-31` },
      $or: [
        { status: { $in: ["confirmed", "completed", "no_show"] } },
        { status: "pending_payment", holdExpiresAt: { $gt: now() } },
      ],
    });
  }

  // ---------- writes ----------

  /**
   * Inserts a booking and one lock per slot in a transaction. The unique lock index makes only
   * one of any number of concurrent requests win a slot (409 SLOT_TAKEN for the rest).
   */
  async function insertWithLocks(
    fields: Omit<BookingRaw, "_id" | "code" | "createdAt" | "updatedAt">,
    lockExpiresAt: Date | undefined,
  ): Promise<BookingDoc> {
    for (let attempt = 0; ; attempt++) {
      const session = await mongoose.startSession();
      try {
        let created: BookingDoc | undefined;
        await session.withTransaction(async () => {
          // Expired holds whose TTL deletion lags must not block these slots.
          await SlotLockModel.deleteMany(
            {
              resourceId: fields.resourceId,
              date: fields.date,
              startTime: { $in: fields.slots },
              expiresAt: { $lte: now() },
            },
            { session },
          );
          const [booking] = await BookingModel.create([{ ...fields, code: bookingCode() }], {
            session,
          });
          await SlotLockModel.insertMany(
            fields.slots.map((startTime) => ({
              resourceId: fields.resourceId,
              date: fields.date,
              startTime,
              bookingId: booking!._id,
              ...(lockExpiresAt ? { expiresAt: lockExpiresAt } : {}),
            })),
            { session, ordered: true },
          );
          created = booking;
        });
        return created!;
      } catch (err) {
        if (dupKeyOn(err, "slotLocks")) throw slotTaken();
        if (dupKeyOn(err, "bookings") && attempt < 3) continue; // booking code clash
        throw err;
      } finally {
        await session.endSession();
      }
    }
  }

  function emit(type: BookingEvent["type"], b: Pick<BookingRaw, "_id" | "venueId" | "date">) {
    events.emit({ type, venueId: String(b.venueId), date: b.date, bookingId: String(b._id) });
  }

  function checkSlots(
    slots: Slot[],
    startTimes: string[],
    durationMins: number,
    mode: "online" | "owner",
  ) {
    if (!areConsecutive(startTimes, durationMins)) {
      throw new HttpError(400, "VALIDATION_FAILED", "Pick consecutive slots");
    }
    const byStart = new Map(slots.map((s) => [s.startTime, s]));
    const chosen = [...startTimes].sort().map((t) => byStart.get(t));
    if (chosen.some((s) => !s)) throw new HttpError(400, "VALIDATION_FAILED", "Unknown slot time");
    const picked = chosen as Slot[];
    if (picked.some((s) => s.status === "taken")) throw slotTaken();
    if (picked.some((s) => s.status === "past"))
      throw new HttpError(400, "SLOT_PAST", "That time has passed");
    if (mode === "online" && picked.some((s) => s.status !== "available")) {
      throw new HttpError(400, "SLOT_UNAVAILABLE", "That slot cannot be booked online");
    }
    return picked;
  }

  async function hold(user: AuthUser, req: HoldRequest): Promise<BookingDoc> {
    assertBookableDate(req.date);
    const resource = await activeResource(req.resourceId);
    const venue = await liveVenue(resource.venueId);
    const slots = await slotsFor(venue, resource, req.date, "online");
    const picked = checkSlots(slots, req.startTimes, resource.slotDurationMins, "online");
    const at = now();
    const holdExpiresAt = new Date(at.getTime() + HOLD_MINUTES * 60_000);
    const prices = picked.map((s) => s.pricePaise ?? 0);
    const member = await memberDiscountFor(user.id, venue._id, req.date);
    const charged = member
      ? prices.map((p) => memberPricePaise(p, member.discountPercent))
      : prices;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const booking = await insertWithLocks(
      {
        venueId: venue._id,
        businessId: venue.businessId,
        resourceId: resource._id,
        userId: oid(user.id),
        customer: req.customer,
        date: req.date,
        startTime: picked[0]!.startTime,
        endTime: picked.at(-1)!.endTime,
        startsAt: istToUtc(req.date, picked[0]!.startTime),
        endsAt: endInstant(req.date, picked.at(-1)!.endTime),
        slots: picked.map((s) => s.startTime),
        source: "online",
        status: "pending_payment",
        amount: bookingAmount(
          charged,
          venue.bookingPolicy?.advancePercent ?? 0,
          (await settings.get()).convenienceFee,
        ),
        balanceCollected: { method: null },
        holdExpiresAt,
        split: false,
        ...(member ? { membershipId: member.membershipId } : {}),
        memberDiscountPaise: sum(prices) - sum(charged),
      },
      holdExpiresAt,
    );
    emit("created", booking);
    return booking;
  }

  /**
   * Confirms a booking whose online payment succeeded (or that needs no payment). Normally the
   * hold's locks just become permanent. If the hold expired first (late payment, §3.5) the slots
   * are re-locked when still free; when someone else took them the result is "conflict" and the
   * caller cancels with a full refund.
   */
  async function confirmPaid(bookingId: string): Promise<"confirmed" | "already" | "conflict"> {
    const session = await mongoose.startSession();
    let result = "conflict" as "confirmed" | "already" | "conflict";
    let booking: BookingDoc | null = null;
    try {
      await session.withTransaction(async () => {
        const at = now();
        booking = await BookingModel.findById(bookingId, null, { session });
        if (!booking) throw notFound("Booking");
        if (["confirmed", "completed", "no_show"].includes(booking.status)) {
          result = "already";
          return;
        }
        if (!["pending_payment", "expired"].includes(booking.status)) {
          result = "conflict";
          return;
        }
        const own = await SlotLockModel.find({ bookingId: booking._id }, null, { session }).lean();
        const ownValid =
          own.filter((l) => !l.expiresAt || l.expiresAt > at).length === booking.slots.length;
        if (ownValid) {
          await SlotLockModel.updateMany(
            { bookingId: booking._id },
            { $unset: { expiresAt: 1 } },
            { session },
          );
        } else {
          await SlotLockModel.deleteMany({ bookingId: booking._id }, { session });
          await SlotLockModel.deleteMany(
            {
              resourceId: booking.resourceId,
              date: booking.date,
              startTime: { $in: booking.slots },
              expiresAt: { $lte: at },
            },
            { session },
          );
          await SlotLockModel.insertMany(
            booking.slots.map((startTime) => ({
              resourceId: booking!.resourceId,
              date: booking!.date,
              startTime,
              bookingId: booking!._id,
            })),
            { session, ordered: true },
          );
        }
        booking.status = "confirmed";
        booking.holdExpiresAt = undefined;
        await booking.save({ session });
        result = "confirmed";
      });
    } catch (err) {
      if (!dupKeyOn(err, "slotLocks")) throw err;
      result = "conflict";
    } finally {
      await session.endSession();
    }
    if (result === "confirmed" && booking) {
      const b = booking as BookingDoc;
      emit("updated", b);
      await notifier.bookingConfirmed(await toDto(b, "player"), {
        userId: b.userId ? String(b.userId) : null,
        businessId: String(b.businessId),
      });
    }
    return result;
  }

  /** Cancels a paid booking the system could not honour, refunding everything paid online. */
  async function systemCancel(bookingId: string, reason: string): Promise<BookingDoc> {
    const booking = await BookingModel.findById(bookingId);
    if (!booking) throw notFound("Booking");
    return finishCancel(booking, "system", reason, paidOnlinePaise(booking.amount), booking.status);
  }

  async function ownerCreate(
    user: AuthUser,
    venueId: string,
    req: OwnerBookingRequest,
  ): Promise<BookingDoc> {
    const { venue } = await loadOwnedVenue(user, venueId);
    const resource = await ResourceModel.findOne({
      _id: oid(req.resourceId),
      venueId: venue._id,
    }).lean();
    if (!resource) throw notFound("Court");
    const raw = venue.toObject<VenueRaw>();
    const slots = await slotsFor(raw, resource, req.date, "owner");
    const picked = checkSlots(slots, req.startTimes, resource.slotDurationMins, "owner");
    const prices = req.source === "block" ? [] : picked.map((s) => s.pricePaise ?? 0);
    const amount = bookingAmount(prices, 0); // walk-ins and phone bookings pay at the venue
    const booking = await insertWithLocks(
      {
        venueId: venue._id,
        businessId: venue.businessId,
        resourceId: resource._id,
        customer: req.customer,
        date: req.date,
        startTime: picked[0]!.startTime,
        endTime: picked.at(-1)!.endTime,
        startsAt: istToUtc(req.date, picked[0]!.startTime),
        endsAt: endInstant(req.date, picked.at(-1)!.endTime),
        slots: picked.map((s) => s.startTime),
        source: req.source,
        status: "confirmed",
        amount,
        balanceCollected: { method: null },
        note: req.note,
        split: false,
        memberDiscountPaise: 0,
      },
      undefined,
    );
    await audit(user.id, `booking.${req.source}`, "booking", String(booking._id), { venueId });
    emit("created", booking);
    return booking;
  }

  /** Court slot start times one batch session covers, checked against that day's slot grid. */
  async function batchSlotsOn(
    batch: Pick<CoachingBatchRaw, "venueId" | "resourceId" | "startTime" | "endTime">,
    date: string,
  ): Promise<{ slots: string[] } | { conflict: "closed" | "taken" | "past" }> {
    const venue = await VenueModel.findById(batch.venueId).lean();
    const resource = await ResourceModel.findById(batch.resourceId).lean();
    if (!venue || !resource) throw notFound("Court");
    const slots = await slotsFor(venue, resource, date, "owner");
    const covered = slots.filter(
      (s) => s.startTime >= batch.startTime && s.endTime <= batch.endTime,
    );
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const span = (minutes(batch.endTime) - minutes(batch.startTime)) / resource.slotDurationMins;
    if (
      covered.length === 0 ||
      covered.length !== span ||
      covered[0]!.startTime !== batch.startTime
    )
      return { conflict: "closed" };
    if (covered.some((s) => s.status === "taken")) return { conflict: "taken" };
    if (covered.some((s) => s.status === "past")) return { conflict: "past" };
    return { slots: covered.map((s) => s.startTime) };
  }

  /**
   * Reserves a batch's court slots on the given dates as confirmed `source: batch` bookings,
   * each through insertWithLocks. Dates already reserved for this batch are skipped; dates whose
   * slots are taken (or outside opening hours) are returned as conflicts.
   */
  async function reserveBatchSlots(
    batch: CoachingBatchRaw,
    dates: string[],
  ): Promise<{ reserved: string[]; conflicts: string[] }> {
    const reserved: string[] = [];
    const conflicts: string[] = [];
    if (!batch.resourceId) return { reserved, conflicts };
    const existing = await BookingModel.find(
      { batchId: batch._id, date: { $in: dates }, status: { $in: ["confirmed", "completed"] } },
      { date: 1 },
    ).lean();
    const done = new Set(existing.map((b) => b.date));
    for (const date of dates) {
      if (done.has(date)) continue;
      const check = await batchSlotsOn(batch, date);
      if ("conflict" in check) {
        if (check.conflict !== "past") conflicts.push(date);
        continue;
      }
      try {
        const booking = await insertWithLocks(
          {
            venueId: batch.venueId,
            businessId: batch.businessId,
            resourceId: batch.resourceId,
            date,
            startTime: batch.startTime,
            endTime: batch.endTime,
            startsAt: istToUtc(date, batch.startTime),
            endsAt: endInstant(date, batch.endTime),
            slots: check.slots,
            source: "batch",
            status: "confirmed",
            amount: bookingAmount([], 0),
            balanceCollected: { method: null },
            note: `${batch.title} · ${batch.coachName}`,
            split: false,
            batchId: batch._id,
            memberDiscountPaise: 0,
          },
          undefined,
        );
        emit("created", booking);
        reserved.push(date);
      } catch (err) {
        if (err instanceof HttpError && err.code === "SLOT_TAKEN") conflicts.push(date);
        else throw err;
      }
    }
    return { reserved, conflicts };
  }

  /** Frees a batch's reserved slots from `fromDate` on (batch ended). */
  async function releaseBatch(batchId: Types.ObjectId, fromDate: string): Promise<number> {
    const rows = await BookingModel.find({
      batchId,
      date: { $gte: fromDate },
      status: "confirmed",
    }).lean();
    for (const b of rows) {
      const res = await BookingModel.updateOne(
        { _id: b._id, status: "confirmed" },
        {
          $set: {
            status: "cancelled",
            cancellation: {
              by: "owner",
              reason: "Batch ended",
              refundPaise: 0,
              refundStatus: "none",
              at: now(),
            },
          },
        },
      );
      if (res.modifiedCount === 1) {
        await SlotLockModel.deleteMany({ bookingId: b._id });
        emit("cancelled", b);
      }
    }
    return rows.length;
  }

  async function loadForOwner(user: AuthUser, bookingId: string) {
    const booking = await BookingModel.findById(bookingId);
    if (!booking) throw notFound("Booking");
    try {
      await loadOwnedVenue(user, String(booking.venueId));
    } catch {
      throw notFound("Booking");
    }
    return booking;
  }

  async function cancel(
    user: AuthUser,
    bookingId: string,
    reason: string | undefined,
  ): Promise<BookingDoc> {
    const booking = await BookingModel.findById(bookingId);
    if (!booking) throw notFound("Booking");
    let by: CancelledBy;
    if (booking.userId && String(booking.userId) === user.id) by = "player";
    else {
      await loadForOwner(user, bookingId);
      by = "owner";
    }
    const at = now();
    if (!(ACTIVE as readonly string[]).includes(booking.status)) {
      throw new HttpError(409, "CONFLICT", `Booking is ${booking.status}`);
    }
    if (by === "player" && booking.startsAt.getTime() <= at.getTime()) {
      throw new HttpError(409, "CONFLICT", "This booking has already started");
    }
    const venue = await VenueModel.findById(booking.venueId, { bookingPolicy: 1 }).lean();
    // Nothing was paid on an unconfirmed hold.
    const refund =
      booking.status === "pending_payment"
        ? 0
        : refundPaise(
            {
              cancellationCutoffHours: venue?.bookingPolicy?.cancellationCutoffHours ?? 0,
              refundPercentBeforeCutoff: venue?.bookingPolicy?.refundPercentBeforeCutoff ?? 0,
            },
            booking,
            by,
            at,
          );

    if (by === "owner") await audit(user.id, "booking.cancel", "booking", bookingId, { refund });
    return finishCancel(booking, by, reason, refund, booking.status);
  }

  async function finishCancel(
    booking: BookingDoc,
    by: CancelledBy,
    reason: string | undefined,
    refund: number,
    fromStatus: BookingStatus,
  ): Promise<BookingDoc> {
    const at = now();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const res = await BookingModel.updateOne(
          { _id: booking._id, status: fromStatus },
          {
            $set: {
              status: "cancelled",
              cancellation: {
                by,
                reason,
                refundPaise: refund,
                refundStatus: refund > 0 ? "pending" : "none",
                at,
              },
            },
            $unset: { holdExpiresAt: 1 },
          },
          { session },
        );
        if (res.modifiedCount !== 1)
          throw new HttpError(409, "CONFLICT", "Booking changed, try again");
        // Only this booking's own locks are freed, never another booking's.
        await SlotLockModel.deleteMany({ bookingId: booking._id }, { session });
      });
    } finally {
      await session.endSession();
    }
    if (refund > 0) {
      let status: RefundStatus = "failed";
      try {
        status = refunder
          ? await refunder.refundBooking(booking._id, refund, reason ?? `cancelled by ${by}`)
          : "failed";
      } catch {
        status = "failed"; // retried by an admin from the payments record
      }
      await BookingModel.updateOne(
        { _id: booking._id },
        { $set: { "cancellation.refundStatus": status } },
      );
    }
    if (onCancelled) await onCancelled(booking._id);
    emit("cancelled", booking);
    const updated = (await BookingModel.findById(booking._id))!;
    await notifier.bookingCancelled(await toDto(updated, "player"), {
      userId: updated.userId ? String(updated.userId) : null,
      businessId: String(updated.businessId),
    });
    return updated;
  }

  async function markBalance(user: AuthUser, bookingId: string, method: "cash" | "upi") {
    const booking = await loadForOwner(user, bookingId);
    if (!["confirmed", "completed"].includes(booking.status)) {
      throw new HttpError(409, "CONFLICT", `Booking is ${booking.status}`);
    }
    booking.set("balanceCollected", { method, at: now() });
    await booking.save();
    await audit(user.id, "booking.balance", "booking", bookingId, { method });
    emit("updated", booking);
    return booking;
  }

  async function markOutcome(user: AuthUser, bookingId: string, outcome: "no_show" | "completed") {
    const booking = await loadForOwner(user, bookingId);
    if (booking.status !== "confirmed")
      throw new HttpError(409, "CONFLICT", `Booking is ${booking.status}`);
    if (booking.startsAt.getTime() > now().getTime()) {
      throw new HttpError(409, "CONFLICT", "This booking has not started yet");
    }
    booking.status = outcome;
    await booking.save();
    await audit(user.id, `booking.${outcome}`, "booking", bookingId);
    emit("updated", booking);
    return booking;
  }

  // ---------- reads ----------

  async function toDtos(bookings: BookingRaw[], viewer: "player" | "owner"): Promise<Booking[]> {
    const venueIds = [...new Set(bookings.map((b) => String(b.venueId)))].map(oid);
    const resourceIds = [...new Set(bookings.map((b) => String(b.resourceId)))].map(oid);
    const [venues, resources] = await Promise.all([
      VenueModel.find({ _id: { $in: venueIds } }).lean(),
      ResourceModel.find({ _id: { $in: resourceIds } }, { name: 1, sport: 1 }).lean(),
    ]);
    const businesses = await BusinessModel.find(
      { _id: { $in: venues.map((v) => v.businessId) } },
      { contactPhone: 1 },
    ).lean();
    const sharesPaid = await sharesPaidFor(bookings.map((b) => b._id));
    const venueById = new Map(venues.map((v) => [String(v._id), v]));
    const resourceById = new Map(resources.map((r) => [String(r._id), r]));
    const phoneByBusiness = new Map(businesses.map((b) => [String(b._id), b.contactPhone]));
    const at = now();
    return bookings.map((b) => {
      const venue = venueById.get(String(b.venueId));
      const resource = resourceById.get(String(b.resourceId));
      const active = (ACTIVE as readonly string[]).includes(b.status) && b.startsAt > at;
      const refundNow =
        viewer === "player" && active
          ? b.status === "pending_payment"
            ? 0
            : refundPaise(
                {
                  cancellationCutoffHours: venue?.bookingPolicy?.cancellationCutoffHours ?? 0,
                  refundPercentBeforeCutoff: venue?.bookingPolicy?.refundPercentBeforeCutoff ?? 0,
                },
                b,
                "player",
                at,
              )
          : null;
      const [lng = 0, lat = 0] = venue?.geo?.coordinates ?? [];
      return {
        id: String(b._id),
        code: b.code,
        venue: {
          id: String(b.venueId),
          name: venue?.name ?? "",
          slug: venue?.slug ?? "",
          citySlug: venue?.citySlug ?? "",
          area: venue?.area ?? "",
          contactPhone: phoneByBusiness.get(String(venue?.businessId)) ?? "",
          location: { lat, lng },
        },
        resource: {
          id: String(b.resourceId),
          name: resource?.name ?? "",
          sport: resource?.sport ?? "",
        },
        customer:
          b.customer?.name && b.customer.phone
            ? { name: b.customer.name, phone: b.customer.phone }
            : null,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        slots: [...b.slots],
        source: b.source,
        status: b.status,
        amount: {
          totalPaise: b.amount.totalPaise,
          advancePaise: b.amount.advancePaise,
          balancePaise: b.amount.balancePaise,
          convenienceFeePaise: b.amount.convenienceFeePaise,
        },
        balanceCollected: {
          method: b.balanceCollected?.method ?? null,
          at: b.balanceCollected?.at?.toISOString() ?? null,
        },
        holdExpiresAt:
          b.status === "pending_payment" ? (b.holdExpiresAt?.toISOString() ?? null) : null,
        cancellation: b.cancellation
          ? {
              by: b.cancellation.by,
              reason: b.cancellation.reason ?? null,
              refundPaise: b.cancellation.refundPaise,
              refundStatus: b.cancellation.refundStatus ?? "none",
              at: b.cancellation.at.toISOString(),
            }
          : null,
        note: viewer === "owner" ? (b.note ?? null) : null,
        sharesPaidPaise: sharesPaid.get(String(b._id)) ?? 0,
        balanceDuePaise: Math.max(0, b.amount.balancePaise - (sharesPaid.get(String(b._id)) ?? 0)),
        openGameId: b.openGameId ? String(b.openGameId) : null,
        split: Boolean(b.split),
        memberDiscountPaise: b.memberDiscountPaise ?? 0,
        refundIfCancelledNowPaise: refundNow,
        createdAt: b.createdAt.toISOString(),
      };
    });
  }

  async function toDto(booking: BookingRaw | BookingDoc, viewer: "player" | "owner") {
    const raw = "toObject" in booking ? booking.toObject<BookingRaw>() : booking;
    return (await toDtos([raw], viewer))[0]!;
  }

  async function listMine(user: AuthUser, scope: "upcoming" | "past"): Promise<Booking[]> {
    const at = now();
    const filter =
      scope === "upcoming"
        ? { userId: oid(user.id), status: { $in: [...ACTIVE] }, endsAt: { $gt: at } }
        : {
            userId: oid(user.id),
            $or: [{ status: { $nin: [...ACTIVE] } }, { endsAt: { $lte: at } }],
          };
    const rows = await BookingModel.find(filter)
      .sort({ startsAt: scope === "upcoming" ? 1 : -1 })
      .limit(50)
      .lean();
    return toDtos(rows, "player");
  }

  async function getForViewer(user: AuthUser, bookingId: string): Promise<Booking> {
    const booking = await BookingModel.findById(bookingId).lean();
    if (!booking) throw notFound("Booking");
    if (booking.userId && String(booking.userId) === user.id) return toDto(booking, "player");
    await loadForOwner(user, bookingId);
    return toDto(booking, "owner");
  }

  async function calendar(user: AuthUser, venueId: string, date: string): Promise<Calendar> {
    const { venue } = await loadOwnedVenue(user, venueId);
    const raw = venue.toObject<VenueRaw>();
    const resources = await ResourceModel.find({ venueId: venue._id, isActive: true })
      .sort({ name: 1 })
      .lean();
    const bookings = await BookingModel.find({
      venueId: venue._id,
      date,
      status: { $in: ["pending_payment", "confirmed", "completed", "no_show"] },
    })
      .sort({ startTime: 1 })
      .lean();
    // An unpaid hold whose time ran out is about to be expired by the job; hide it now.
    const at = now();
    const visible = bookings.filter(
      (b) => b.status !== "pending_payment" || (b.holdExpiresAt ?? at) > at,
    );
    return {
      venueId,
      date,
      resources: await availabilityOf(raw, resources, date, "owner"),
      bookings: await toDtos(visible, "owner"),
    };
  }

  // ---------- jobs ----------

  /** Marks unpaid holds past their expiry as expired and frees their slots. */
  async function expireHolds(): Promise<number> {
    const at = now();
    const stale = await BookingModel.find({
      status: "pending_payment",
      holdExpiresAt: { $lte: at },
    }).lean();
    let expired = 0;
    for (const b of stale) {
      const res = await BookingModel.updateOne(
        { _id: b._id, status: "pending_payment" },
        { $set: { status: "expired" } },
      );
      if (res.modifiedCount === 1) {
        await SlotLockModel.deleteMany({ bookingId: b._id, expiresAt: { $exists: true } });
        emit("cancelled", b);
        expired++;
      }
    }
    return expired;
  }

  /** Confirmed bookings whose end time has passed become completed. */
  async function completeFinished(): Promise<number> {
    const due = await BookingModel.find(
      { status: "confirmed", endsAt: { $lte: now() } },
      { venueId: 1, date: 1 },
    ).lean();
    if (due.length === 0) return 0;
    await BookingModel.updateMany(
      { _id: { $in: due.map((b) => b._id) }, status: "confirmed" },
      { $set: { status: "completed" } },
    );
    for (const b of due) emit("updated", b);
    return due.length;
  }

  return {
    venueAvailability,
    resourceAvailability,
    hold,
    confirmPaid,
    systemCancel,
    setRefunder,
    setOnCancelled,
    ownerCreate,
    cancel,
    markBalance,
    markOutcome,
    listMine,
    getForViewer,
    calendar,
    toDto,
    reserveBatchSlots,
    releaseBatch,
    bookingsUsed,
    expireHolds,
    completeFinished,
  };
}

/** "24:00" ends at midnight of the next day. */
function endInstant(date: string, endTime: string): Date {
  if (endTime === "24:00") return new Date(istToUtc(date, "00:00").getTime() + 86_400_000);
  return istToUtc(date, endTime);
}

export type BookingService = ReturnType<typeof createBookingService>;
