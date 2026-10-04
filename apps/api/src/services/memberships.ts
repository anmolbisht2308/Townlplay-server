import {
  BATCH_LOCK_DAYS,
  MEMBERSHIP_HOLD_MINUTES,
  RENEWAL_REMINDER_DAYS,
  addDays,
  batchDates,
  convenienceFeePaise,
  formatPaise,
  istDate,
  membershipPeriod,
  type Attendance,
  type Batch,
  type CreateBatch,
  type JoinMembershipRequest,
  type MemberRow,
  type Membership,
  type Plan,
  type PlanInput,
  type UpdateBatch,
  type VenueOfferings,
} from "@townplay/shared";
import type { Logger } from "pino";
import { Types, type QueryFilter } from "mongoose";
import { bookingCode } from "../lib/bookingCode.js";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { AttendanceModel } from "../models/attendance.js";
import { BusinessModel } from "../models/business.js";
import { CoachingBatchModel, type CoachingBatchRaw } from "../models/coachingBatch.js";
import { EventModel } from "../models/event.js";
import { MembershipModel, type MembershipRaw } from "../models/membership.js";
import { MembershipPlanModel, type MembershipPlanRaw } from "../models/membershipPlan.js";
import { ResourceModel } from "../models/resource.js";
import { UserModel } from "../models/user.js";
import { VenueModel } from "../models/venue.js";
import { audit } from "./audit.js";
import type { BookingService, RefundStatus } from "./bookings.js";
import type { EmailSender } from "./email.js";
import { toEventCard } from "./events.js";
import { loadOwnedVenue } from "./listings.js";
import type { PushSender } from "./push.js";
import type { SettingsService } from "./settings.js";

const oid = (id: string) => new Types.ObjectId(id);
const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export interface MembershipRefunder {
  refundMembership(id: Types.ObjectId, amountPaise: number, reason: string): Promise<RefundStatus>;
}

/**
 * Membership plans, coaching batches and the memberships players buy (docs/PLAN.md Phase 6).
 * Batch seats: `seatsTaken` is only changed by conditional updates (take: `seatsTaken <
 * capacity`); a renewal inherits its predecessor's seat when that one ends. Batch court slots are
 * reserved through bookings.reserveBatchSlots (slotLocks), BATCH_LOCK_DAYS ahead.
 */
export function createMembershipService(deps: {
  bookings: BookingService;
  settings: SettingsService;
  email: EmailSender;
  push: PushSender;
  logger: Logger;
  webOrigin: string;
  now?: () => Date;
}) {
  const { bookings, settings, email, push, logger, webOrigin, now = () => new Date() } = deps;
  let refunder: MembershipRefunder | undefined;
  const today = () => istDate(now());

  // ---------- DTOs ----------

  function toPlan(p: MembershipPlanRaw): Plan {
    return {
      id: String(p._id),
      venueId: String(p.venueId),
      name: p.name,
      description: p.description ?? "",
      durationMonths: p.durationMonths,
      pricePaise: p.pricePaise,
      discountPercent: p.discountPercent,
      bookingsPerMonth: p.bookingsPerMonth ?? null,
      isActive: p.isActive,
    };
  }

  async function toBatches(rows: CoachingBatchRaw[]): Promise<Batch[]> {
    const resources = await ResourceModel.find(
      { _id: { $in: rows.map((b) => b.resourceId).filter(Boolean) } },
      { name: 1 },
    ).lean();
    const nameOf = new Map(resources.map((r) => [String(r._id), r.name]));
    return rows.map((b) => ({
      id: String(b._id),
      venueId: String(b.venueId),
      title: b.title,
      activity: b.activity,
      coachName: b.coachName,
      description: b.description ?? "",
      resourceId: b.resourceId ? String(b.resourceId) : null,
      resourceName: b.resourceId ? (nameOf.get(String(b.resourceId)) ?? null) : null,
      days: [...b.days],
      startTime: b.startTime,
      endTime: b.endTime,
      capacity: b.capacity,
      seatsLeft: Math.max(0, b.capacity - b.seatsTaken),
      monthlyFeePaise: b.monthlyFeePaise,
      startDate: b.startDate,
      endDate: b.endDate ?? null,
      status: b.status,
    }));
  }

  async function toMemberships(rows: MembershipRaw[]): Promise<Membership[]> {
    const ids = (xs: (Types.ObjectId | null | undefined)[]) => [
      ...new Set(xs.filter(Boolean).map(String)),
    ];
    const [plans, batches, venues, renewals] = await Promise.all([
      MembershipPlanModel.find({ _id: { $in: ids(rows.map((m) => m.planId)) } }).lean(),
      CoachingBatchModel.find({ _id: { $in: ids(rows.map((m) => m.batchId)) } }).lean(),
      VenueModel.find({ _id: { $in: ids(rows.map((m) => m.venueId)) } }).lean(),
      MembershipModel.find(
        {
          renewalOf: { $in: rows.map((m) => m._id) },
          status: { $in: ["pending_payment", "active"] },
        },
        { renewalOf: 1 },
      ).lean(),
    ]);
    const businesses = await BusinessModel.find(
      { _id: { $in: venues.map((v) => v.businessId) } },
      { contactPhone: 1 },
    ).lean();
    const plan = new Map(plans.map((p) => [String(p._id), p]));
    const batch = new Map(batches.map((b) => [String(b._id), b]));
    const venue = new Map(venues.map((v) => [String(v._id), v]));
    const phone = new Map(businesses.map((b) => [String(b._id), b.contactPhone]));
    const renewedBy = new Map(renewals.map((r) => [String(r.renewalOf), String(r._id)]));
    const day = today();
    return Promise.all(
      rows.map(async (m): Promise<Membership> => {
        const p = m.planId ? plan.get(String(m.planId)) : undefined;
        const b = m.batchId ? batch.get(String(m.batchId)) : undefined;
        const v = venue.get(String(m.venueId));
        const active = m.status === "active" && m.endsOn >= day;
        const next = renewedBy.get(String(m._id)) ?? null;
        const offered = m.kind === "plan" ? Boolean(p?.isActive) : b?.status === "active";
        return {
          id: String(m._id),
          kind: m.kind,
          plan: p
            ? {
                id: String(p._id),
                name: p.name,
                durationMonths: p.durationMonths,
                discountPercent: p.discountPercent,
                bookingsPerMonth: p.bookingsPerMonth ?? null,
              }
            : null,
          batch: b
            ? {
                id: String(b._id),
                title: b.title,
                coachName: b.coachName,
                days: [...b.days],
                startTime: b.startTime,
                endTime: b.endTime,
              }
            : null,
          venue: {
            id: String(m.venueId),
            name: v?.name ?? "",
            slug: v?.slug ?? "",
            citySlug: v?.citySlug ?? "",
            contactPhone: phone.get(String(v?.businessId)) ?? "",
          },
          member: { name: m.member.name, phone: m.member.phone },
          startsOn: m.startsOn,
          endsOn: m.endsOn,
          pricePaise: m.pricePaise,
          convenienceFeePaise: m.convenienceFeePaise,
          status: m.status,
          holdExpiresAt:
            m.status === "pending_payment" ? (m.holdExpiresAt?.toISOString() ?? null) : null,
          renewalOf: m.renewalOf ? String(m.renewalOf) : null,
          renewedBy: next,
          renewable: active && !next && offered,
          daysLeft: active ? Math.max(0, daysBetween(day, m.endsOn)) : null,
          bookingsUsedThisMonth:
            active && p && p.bookingsPerMonth !== null && p.bookingsPerMonth !== undefined
              ? await bookings.bookingsUsed(m._id, day.slice(0, 7))
              : null,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    );
  }

  const toMembership = async (m: MembershipRaw) => (await toMemberships([m]))[0]!;

  // ---------- seats ----------

  async function takeSeat(batchId: Types.ObjectId): Promise<boolean> {
    const res = await CoachingBatchModel.updateOne(
      { _id: batchId, status: "active", $expr: { $lt: ["$seatsTaken", "$capacity"] } },
      { $inc: { seatsTaken: 1 } },
    );
    return res.modifiedCount === 1;
  }

  async function releaseSeat(batchId: Types.ObjectId) {
    await CoachingBatchModel.updateOne(
      { _id: batchId, seatsTaken: { $gt: 0 } },
      { $inc: { seatsTaken: -1 } },
    );
  }

  // ---------- owner: plans ----------

  async function listPlans(user: AuthUser, venueId: string): Promise<Plan[]> {
    const { venue } = await loadOwnedVenue(user, venueId);
    const rows = await MembershipPlanModel.find({ venueId: venue._id })
      .sort({ createdAt: 1 })
      .lean();
    return rows.map(toPlan);
  }

  async function createPlan(user: AuthUser, venueId: string, input: PlanInput): Promise<Plan> {
    const { venue } = await loadOwnedVenue(user, venueId);
    const plan = await MembershipPlanModel.create({
      ...input,
      venueId: venue._id,
      businessId: venue.businessId,
    });
    await audit(user.id, "plan.create", "membershipPlan", String(plan._id), { venueId });
    return toPlan(plan.toObject<MembershipPlanRaw>());
  }

  async function updatePlan(user: AuthUser, planId: string, input: PlanInput): Promise<Plan> {
    const plan = await MembershipPlanModel.findById(planId);
    if (!plan) throw notFound("Plan");
    try {
      await loadOwnedVenue(user, String(plan.venueId));
    } catch {
      throw notFound("Plan");
    }
    // Existing members keep what they bought: price and duration apply to new purchases.
    plan.set(input);
    await plan.save();
    await audit(user.id, "plan.update", "membershipPlan", planId, input);
    return toPlan(plan.toObject<MembershipPlanRaw>());
  }

  // ---------- owner: batches ----------

  async function loadOwnedBatch(user: AuthUser, batchId: string) {
    const batch = await CoachingBatchModel.findById(batchId);
    if (!batch) throw notFound("Batch");
    try {
      await loadOwnedVenue(user, String(batch.venueId));
    } catch {
      throw notFound("Batch");
    }
    return batch;
  }

  async function listBatches(user: AuthUser, venueId: string): Promise<Batch[]> {
    const { venue } = await loadOwnedVenue(user, venueId);
    return toBatches(
      await CoachingBatchModel.find({ venueId: venue._id })
        .sort({ status: 1, createdAt: 1 })
        .lean(),
    );
  }

  /**
   * Creates a batch and reserves its court slots for the next BATCH_LOCK_DAYS. Any clash (slot
   * already booked, or outside opening hours) undoes everything: 409 with the clashing dates.
   */
  async function createBatch(user: AuthUser, venueId: string, input: CreateBatch): Promise<Batch> {
    const { venue } = await loadOwnedVenue(user, venueId);
    if (input.resourceId) {
      const resource = await ResourceModel.findOne({
        _id: oid(input.resourceId),
        venueId: venue._id,
        isActive: true,
      }).lean();
      if (!resource) throw notFound("Court");
    }
    if (input.startDate < today())
      throw new HttpError(400, "VALIDATION_FAILED", "The start date has passed");
    const doc = await CoachingBatchModel.create({
      ...input,
      resourceId: input.resourceId ? oid(input.resourceId) : null,
      venueId: venue._id,
      businessId: venue.businessId,
    });
    const batch = doc.toObject<CoachingBatchRaw>();
    if (batch.resourceId) {
      const until = addDays(today(), BATCH_LOCK_DAYS - 1);
      const { conflicts } = await bookings.reserveBatchSlots(
        batch,
        batchDates(batch, today(), until),
      );
      if (conflicts.length > 0) {
        await bookings.releaseBatch(batch._id, "0000-01-01");
        await CoachingBatchModel.deleteOne({ _id: batch._id });
        throw new HttpError(
          409,
          "SLOT_TAKEN",
          "The court is booked or closed at this time on some days",
          { dates: conflicts },
        );
      }
      await CoachingBatchModel.updateOne({ _id: batch._id }, { $set: { locksUntil: until } });
    }
    await audit(user.id, "batch.create", "coachingBatch", String(batch._id), { venueId });
    return (await toBatches([batch]))[0]!;
  }

  async function updateBatch(user: AuthUser, batchId: string, input: UpdateBatch): Promise<Batch> {
    const batch = await loadOwnedBatch(user, batchId);
    if (input.capacity < batch.seatsTaken)
      throw new HttpError(409, "CONFLICT", `${batch.seatsTaken} seats are already taken`);
    batch.set(input);
    await batch.save();
    await audit(user.id, "batch.update", "coachingBatch", batchId, input);
    return (await toBatches([batch.toObject<CoachingBatchRaw>()]))[0]!;
  }

  /** Ends a batch after today: frees its future slots; no new members or renewals. */
  async function endBatch(user: AuthUser, batchId: string): Promise<Batch> {
    const batch = await loadOwnedBatch(user, batchId);
    if (batch.status === "ended") throw new HttpError(409, "CONFLICT", "Batch already ended");
    batch.status = "ended";
    batch.endDate = today();
    await batch.save();
    await bookings.releaseBatch(batch._id, addDays(today(), 1));
    await audit(user.id, "batch.end", "coachingBatch", batchId);
    return (await toBatches([batch.toObject<CoachingBatchRaw>()]))[0]!;
  }

  // ---------- owner: members + attendance ----------

  async function members(
    user: AuthUser,
    venueId: string,
    q: { status: "current" | "expired" | "all"; batchId?: string },
  ): Promise<MemberRow[]> {
    const { venue } = await loadOwnedVenue(user, venueId);
    const day = today();
    const statusFilter: QueryFilter<MembershipRaw> =
      q.status === "current"
        ? { status: "active", endsOn: { $gte: day } }
        : q.status === "expired"
          ? { $or: [{ status: "expired", paidAt: { $exists: true } }, { status: "cancelled" }] }
          : { status: { $ne: "pending_payment" }, paidAt: { $exists: true } };
    const rows = await MembershipModel.find({
      venueId: venue._id,
      ...(q.batchId ? { batchId: oid(q.batchId) } : {}),
      ...statusFilter,
    })
      .sort({ endsOn: 1 })
      .limit(500)
      .lean();
    const [plans, batches, renewals] = await Promise.all([
      MembershipPlanModel.find({ venueId: venue._id }, { name: 1 }).lean(),
      CoachingBatchModel.find({ venueId: venue._id }, { title: 1 }).lean(),
      MembershipModel.find(
        { renewalOf: { $in: rows.map((m) => m._id) }, status: "active" },
        { renewalOf: 1 },
      ).lean(),
    ]);
    const nameOf = new Map([
      ...plans.map((p) => [String(p._id), p.name] as const),
      ...batches.map((b) => [String(b._id), b.title] as const),
    ]);
    const renewed = new Set(renewals.map((r) => String(r.renewalOf)));
    return rows.map((m) => ({
      id: String(m._id),
      kind: m.kind,
      name: nameOf.get(String(m.planId ?? m.batchId)) ?? "",
      member: { name: m.member.name, phone: m.member.phone },
      startsOn: m.startsOn,
      endsOn: m.endsOn,
      status: m.status,
      pricePaise: m.pricePaise,
      renewed: renewed.has(String(m._id)),
    }));
  }

  async function attendance(user: AuthUser, batchId: string, date: string): Promise<Attendance> {
    const batch = await loadOwnedBatch(user, batchId);
    const [roster, record] = await Promise.all([
      MembershipModel.find({
        batchId: batch._id,
        status: "active",
        startsOn: { $lte: date },
        endsOn: { $gte: date },
      })
        .sort({ "member.name": 1 })
        .lean(),
      AttendanceModel.findOne({ batchId: batch._id, date }).lean(),
    ]);
    const present = new Set((record?.present ?? []).map(String));
    return {
      batchId,
      batchTitle: batch.title,
      venueId: String(batch.venueId),
      date,
      scheduled: batchDates(batch, date, date).length === 1,
      members: roster.map((m) => ({
        membershipId: String(m._id),
        name: m.member.name,
        phone: m.member.phone,
        present: present.has(String(m._id)),
      })),
    };
  }

  async function markAttendance(
    user: AuthUser,
    batchId: string,
    input: { date: string; present: string[] },
  ): Promise<Attendance> {
    const batch = await loadOwnedBatch(user, batchId);
    if (input.date > today())
      throw new HttpError(400, "VALIDATION_FAILED", "Attendance can't be marked in advance");
    const roster = await MembershipModel.find(
      {
        _id: { $in: input.present.map(oid) },
        batchId: batch._id,
        status: "active",
        startsOn: { $lte: input.date },
        endsOn: { $gte: input.date },
      },
      { _id: 1 },
    ).lean();
    if (roster.length !== new Set(input.present).size)
      throw new HttpError(400, "VALIDATION_FAILED", "Someone in the list is not a member that day");
    await AttendanceModel.updateOne(
      { batchId: batch._id, date: input.date },
      { $set: { present: roster.map((m) => m._id), markedBy: oid(user.id) } },
      { upsert: true },
    );
    return attendance(user, batchId, input.date);
  }

  /** Owner cancels a membership: everything paid online is refunded, the seat is freed. */
  async function ownerCancel(user: AuthUser, membershipId: string, reason: string | undefined) {
    const m = await MembershipModel.findById(membershipId);
    if (!m) throw notFound("Membership");
    try {
      await loadOwnedVenue(user, String(m.venueId));
    } catch {
      throw notFound("Membership");
    }
    if (!["active", "pending_payment"].includes(m.status))
      throw new HttpError(409, "CONFLICT", `Membership is ${m.status}`);
    await audit(user.id, "membership.cancel", "membership", membershipId, { reason });
    await cancelWithRefund(m._id, m.status, reason ?? "Cancelled by the venue");
    return toMembership((await MembershipModel.findById(m._id).lean())!);
  }

  async function cancelWithRefund(
    id: Types.ObjectId,
    fromStatus: MembershipRaw["status"],
    reason: string,
  ) {
    const m = await MembershipModel.findOneAndUpdate(
      { _id: id, status: fromStatus },
      { $set: { status: "cancelled" }, $unset: { holdExpiresAt: 1 } },
      { returnDocument: "before" },
    ).lean();
    if (!m) throw new HttpError(409, "CONFLICT", "Membership changed, try again");
    if (m.seatHeld && m.batchId) {
      await releaseSeat(m.batchId);
      await MembershipModel.updateOne({ _id: id }, { $set: { seatHeld: false } });
    }
    const paid = m.paidAt ? m.pricePaise + m.convenienceFeePaise : 0;
    let refundStatus: RefundStatus = "none";
    if (paid > 0) {
      try {
        refundStatus = refunder ? await refunder.refundMembership(id, paid, reason) : "failed";
      } catch {
        refundStatus = "failed";
      }
    }
    await MembershipModel.updateOne(
      { _id: id },
      { $set: { cancellation: { reason, refundPaise: paid, refundStatus, at: now() } } },
    );
  }

  // ---------- public ----------

  async function offerings(venueId: string): Promise<VenueOfferings> {
    const venue = await VenueModel.findOne({
      _id: venueId,
      status: "live",
      businessActive: true,
    }).lean();
    if (!venue) throw notFound("Venue");
    const [plans, batches, sessions] = await Promise.all([
      MembershipPlanModel.find({ venueId: venue._id, isActive: true })
        .sort({ pricePaise: 1 })
        .lean(),
      CoachingBatchModel.find({ venueId: venue._id, status: "active" })
        .sort({ startTime: 1 })
        .lean(),
      EventModel.find({
        venueId: venue._id,
        type: "club_session",
        status: "published",
        businessActive: true,
        endsAt: { $gt: now() },
      })
        .sort({ startsAt: 1 })
        .limit(10)
        .lean(),
    ]);
    return {
      plans: plans.map(toPlan),
      batches: await toBatches(batches),
      sessions: sessions.map((e) => toEventCard(e, venue.name)),
    };
  }

  // ---------- player ----------

  async function feeFor(pricePaise: number) {
    return convenienceFeePaise(pricePaise, (await settings.get()).convenienceFee);
  }

  async function liveVenueOf(venueId: Types.ObjectId) {
    const venue = await VenueModel.findOne({
      _id: venueId,
      status: "live",
      businessActive: true,
    }).lean();
    if (!venue) throw notFound("Venue");
    return venue;
  }

  async function insertMembership(
    fields: Omit<MembershipRaw, "_id" | "code" | "createdAt" | "updatedAt" | "seatHeld"> & {
      seatHeld?: boolean;
    },
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await MembershipModel.create({ ...fields, code: `M${bookingCode(5)}` });
      } catch (err) {
        const dup = typeof err === "object" && err !== null && "code" in err && err.code === 11000;
        if (dup && "message" in err && String(err.message).includes("renewalOf"))
          throw new HttpError(409, "CONFLICT", "This membership is already being renewed");
        if (dup && attempt < 3) continue;
        throw err;
      }
    }
  }

  async function join(user: AuthUser, req: JoinMembershipRequest): Promise<Membership> {
    const at = now();
    const day = today();
    const holdExpiresAt = new Date(at.getTime() + MEMBERSHIP_HOLD_MINUTES * 60_000);
    const already = await MembershipModel.exists({
      userId: oid(user.id),
      ...(req.planId ? { planId: oid(req.planId) } : { batchId: oid(req.batchId!) }),
      $or: [
        { status: "active", endsOn: { $gte: day } },
        { status: "pending_payment", holdExpiresAt: { $gt: at } },
      ],
    });
    if (already)
      throw new HttpError(409, "ALREADY_MEMBER", "You are already a member. Renew it instead.");

    if (req.planId) {
      const plan = await MembershipPlanModel.findOne({
        _id: oid(req.planId),
        isActive: true,
      }).lean();
      if (!plan) throw notFound("Plan");
      const venue = await liveVenueOf(plan.venueId);
      const m = await insertMembership({
        kind: "plan",
        planId: plan._id,
        businessId: venue.businessId,
        venueId: venue._id,
        userId: oid(user.id),
        member: req.member,
        ...membershipPeriod(day, plan.durationMonths),
        pricePaise: plan.pricePaise,
        convenienceFeePaise: await feeFor(plan.pricePaise),
        status: "pending_payment",
        holdExpiresAt,
      });
      return toMembership(m.toObject<MembershipRaw>());
    }

    const batch = await CoachingBatchModel.findOne({
      _id: oid(req.batchId!),
      status: "active",
    }).lean();
    if (!batch) throw notFound("Batch");
    const venue = await liveVenueOf(batch.venueId);
    if (!(await takeSeat(batch._id))) throw new HttpError(409, "BATCH_FULL", "This batch is full");
    try {
      const m = await insertMembership({
        kind: "batch",
        batchId: batch._id,
        businessId: venue.businessId,
        venueId: venue._id,
        userId: oid(user.id),
        member: req.member,
        ...membershipPeriod(batch.startDate > day ? batch.startDate : day, 1),
        pricePaise: batch.monthlyFeePaise,
        convenienceFeePaise: await feeFor(batch.monthlyFeePaise),
        status: "pending_payment",
        holdExpiresAt,
        seatHeld: true,
      });
      return toMembership(m.toObject<MembershipRaw>());
    } catch (err) {
      await releaseSeat(batch._id);
      throw err;
    }
  }

  /** A renewal starts the day after the current period ends, at today's price. */
  async function renew(user: AuthUser, membershipId: string): Promise<Membership> {
    const prev = await MembershipModel.findById(membershipId).lean();
    if (!prev || String(prev.userId) !== user.id) throw notFound("Membership");
    if (prev.status !== "active" || prev.endsOn < today())
      throw new HttpError(409, "CONFLICT", "Only an active membership can be renewed");
    const at = now();
    const holdExpiresAt = new Date(at.getTime() + MEMBERSHIP_HOLD_MINUTES * 60_000);
    let months = 1;
    let price: number;
    if (prev.kind === "plan") {
      const plan = await MembershipPlanModel.findOne({ _id: prev.planId, isActive: true }).lean();
      if (!plan) throw new HttpError(409, "CONFLICT", "This plan is no longer sold");
      months = plan.durationMonths;
      price = plan.pricePaise;
    } else {
      const batch = await CoachingBatchModel.findOne({
        _id: prev.batchId,
        status: "active",
      }).lean();
      if (!batch) throw new HttpError(409, "CONFLICT", "This batch has ended");
      price = batch.monthlyFeePaise;
    }
    await liveVenueOf(prev.venueId);
    // An unpaid renewal whose hold ran out no longer blocks a new one.
    await MembershipModel.updateMany(
      { renewalOf: prev._id, status: "pending_payment", holdExpiresAt: { $lte: at } },
      { $set: { status: "expired" } },
    );
    const m = await insertMembership({
      kind: prev.kind,
      ...(prev.planId ? { planId: prev.planId } : {}),
      ...(prev.batchId ? { batchId: prev.batchId } : {}),
      businessId: prev.businessId,
      venueId: prev.venueId,
      userId: prev.userId,
      member: { name: prev.member.name, phone: prev.member.phone },
      ...membershipPeriod(addDays(prev.endsOn, 1), months),
      pricePaise: price,
      convenienceFeePaise: await feeFor(price),
      status: "pending_payment",
      holdExpiresAt,
      renewalOf: prev._id,
    });
    return toMembership(m.toObject<MembershipRaw>());
  }

  async function listMine(user: AuthUser): Promise<Membership[]> {
    const rows = await MembershipModel.find({
      userId: oid(user.id),
      $or: [
        { status: { $in: ["active", "cancelled"] } },
        { paidAt: { $exists: true } },
        { status: "pending_payment", holdExpiresAt: { $gt: now() } },
      ],
    })
      .sort({ endsOn: -1 })
      .limit(50)
      .lean();
    return toMemberships(rows);
  }

  async function getMine(user: AuthUser, id: string): Promise<Membership> {
    const m = await MembershipModel.findById(id).lean();
    if (!m || String(m.userId) !== user.id) throw notFound("Membership");
    return toMembership(m);
  }

  // ---------- payments ----------

  /** The player's own membership awaiting payment, still within its hold. */
  async function payable(user: AuthUser, id: string) {
    const m = await MembershipModel.findById(id).lean();
    if (!m || String(m.userId) !== user.id) throw notFound("Membership");
    if (m.status !== "pending_payment" || !m.holdExpiresAt || m.holdExpiresAt <= now())
      throw new HttpError(
        409,
        "HOLD_EXPIRED",
        "This has expired. Start again from the venue page.",
      );
    return m;
  }

  /**
   * Payment captured. A lapsed hold is honoured if a batch seat can still be had (renewals keep
   * their predecessor's seat); otherwise "conflict" and the caller refunds in full.
   */
  async function confirmPaid(id: string): Promise<"confirmed" | "already" | "conflict"> {
    const m = await MembershipModel.findById(id).lean();
    if (!m) throw notFound("Membership");
    if (m.paidAt) return "already";
    if (!["pending_payment", "expired"].includes(m.status)) return "conflict";
    let seatHeld = m.seatHeld;
    let tookSeat = false;
    if (m.kind === "batch" && !seatHeld) {
      const prev = m.renewalOf ? await MembershipModel.findById(m.renewalOf).lean() : null;
      const inherits = prev && prev.status === "active" && prev.seatHeld;
      if (!inherits) {
        if (!m.batchId || !(await takeSeat(m.batchId))) return "conflict";
        seatHeld = tookSeat = true;
      }
    }
    const res = await MembershipModel.updateOne(
      { _id: m._id, status: m.status, paidAt: { $exists: false } },
      { $set: { status: "active", paidAt: now(), seatHeld }, $unset: { holdExpiresAt: 1 } },
    );
    if (res.modifiedCount !== 1) {
      if (tookSeat && m.batchId) await releaseSeat(m.batchId);
      return confirmPaid(id);
    }
    return "confirmed";
  }

  /** Paid but cannot be honoured (batch full, ended): refund everything. */
  async function systemRefund(id: string, reason: string) {
    const m = await MembershipModel.findById(id).lean();
    if (!m || m.status === "cancelled") return;
    // Mark paid first so the refund covers price + fee.
    await MembershipModel.updateOne({ _id: m._id }, { $set: { paidAt: now() } });
    await cancelWithRefund(m._id, m.status, reason);
  }

  // ---------- jobs ----------

  /** Unpaid memberships past their hold expire and give their batch seat back. */
  async function expireHolds(): Promise<number> {
    const stale = await MembershipModel.find({
      status: "pending_payment",
      holdExpiresAt: { $lte: now() },
    }).lean();
    let n = 0;
    for (const m of stale) {
      const res = await MembershipModel.updateOne(
        { _id: m._id, status: "pending_payment" },
        { $set: { status: "expired", seatHeld: false } },
      );
      if (res.modifiedCount === 1) {
        if (m.seatHeld && m.batchId) await releaseSeat(m.batchId);
        n++;
      }
    }
    return n;
  }

  /** Periods that ended become expired; the seat passes to a paid renewal or is freed. */
  async function expireEnded(): Promise<number> {
    const ended = await MembershipModel.find({ status: "active", endsOn: { $lt: today() } }).lean();
    let n = 0;
    for (const m of ended) {
      const res = await MembershipModel.updateOne(
        { _id: m._id, status: "active" },
        { $set: { status: "expired", seatHeld: false } },
      );
      if (res.modifiedCount !== 1) continue;
      n++;
      if (!m.seatHeld || !m.batchId) continue;
      const passed = await MembershipModel.updateOne(
        { renewalOf: m._id, status: "active", seatHeld: false },
        { $set: { seatHeld: true } },
      );
      if (passed.modifiedCount !== 1) await releaseSeat(m.batchId);
    }
    return n;
  }

  /** Email + push a few days before a membership ends (once, and only if not renewed). */
  async function sendReminders(): Promise<number> {
    const day = today();
    const due = await MembershipModel.find({
      status: "active",
      endsOn: { $gte: day, $lte: addDays(day, RENEWAL_REMINDER_DAYS) },
      reminderSentAt: { $exists: false },
    }).lean();
    if (due.length === 0) return 0;
    const dtos = await toMemberships(due);
    let n = 0;
    for (const [i, m] of due.entries()) {
      const dto = dtos[i]!;
      const claimed = await MembershipModel.updateOne(
        { _id: m._id, reminderSentAt: { $exists: false } },
        { $set: { reminderSentAt: now() } },
      );
      if (claimed.modifiedCount !== 1 || dto.renewedBy) continue;
      const what = dto.plan?.name ?? dto.batch?.title ?? "membership";
      const url = `${webOrigin}/memberships/${dto.id}`;
      try {
        const user = await UserModel.findById(m.userId, { email: 1 }).lean();
        if (user?.email)
          await email.send({
            to: user.email,
            subject: `Your ${what} at ${dto.venue.name} ends on ${dto.endsOn}`,
            text: `Hi ${m.member.name},\n\nYour ${what} at ${dto.venue.name} ends on ${dto.endsOn}. Renew for ${formatPaise(m.pricePaise)} to keep your benefits${dto.batch ? " and your seat" : ""}:\n${url}\n\nTownplay`,
          });
        await push.send([String(m.userId)], {
          title: `${what} ends on ${dto.endsOn}`,
          body: `Renew to keep it going at ${dto.venue.name}`,
          url: `/memberships/${dto.id}`,
        });
        n++;
      } catch (err) {
        logger.error({ err, membershipId: String(m._id) }, "membership reminder failed");
      }
    }
    return n;
  }

  /** Keeps every active batch's court slots reserved BATCH_LOCK_DAYS ahead. */
  async function topUpBatchLocks(): Promise<number> {
    const until = addDays(today(), BATCH_LOCK_DAYS - 1);
    const due = await CoachingBatchModel.find({
      status: "active",
      resourceId: { $ne: null },
      $or: [{ locksUntil: null }, { locksUntil: { $lt: until } }],
    }).lean();
    let reservedTotal = 0;
    for (const batch of due) {
      const from = batch.locksUntil ? addDays(batch.locksUntil, 1) : today();
      const { reserved, conflicts } = await bookings.reserveBatchSlots(
        batch,
        batchDates(batch, from < today() ? today() : from, until),
      );
      reservedTotal += reserved.length;
      if (conflicts.length)
        logger.warn({ batchId: String(batch._id), conflicts }, "batch slots already booked");
      await CoachingBatchModel.updateOne({ _id: batch._id }, { $set: { locksUntil: until } });
    }
    return reservedTotal;
  }

  return {
    setRefunder: (r: MembershipRefunder) => {
      refunder = r;
    },
    listPlans,
    createPlan,
    updatePlan,
    listBatches,
    createBatch,
    updateBatch,
    endBatch,
    members,
    attendance,
    markAttendance,
    ownerCancel,
    offerings,
    join,
    renew,
    listMine,
    getMine,
    payable,
    confirmPaid,
    systemRefund,
    expireHolds,
    expireEnded,
    sendReminders,
    topUpBatchLocks,
  };
}

export type MembershipService = ReturnType<typeof createMembershipService>;
