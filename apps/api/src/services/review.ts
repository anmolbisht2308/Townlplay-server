import {
  BUSINESS_STATUSES,
  EVENT_STATUSES,
  VENUE_STATUSES,
  type EventStatus,
  type BusinessStatus,
  type ReviewQueueItem,
  type VenueStatus,
} from "@townplay/shared";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BusinessModel, type BusinessDoc } from "../models/business.js";
import { EventModel } from "../models/event.js";
import { VenueModel } from "../models/venue.js";
import { audit } from "./audit.js";

async function setBusinessStatus(
  business: BusinessDoc,
  status: "active" | "draft" | "suspended",
  reviewNote?: string,
) {
  business.status = status;
  business.reviewNote = reviewNote;
  await business.save();
  await VenueModel.updateMany(
    { businessId: business._id },
    { $set: { businessActive: status === "active" } },
  );
  await EventModel.updateMany(
    { businessId: business._id },
    { $set: { businessActive: status === "active" } },
  );
}

async function loadBusiness(id: string) {
  const business = await BusinessModel.findById(id);
  if (!business) throw notFound("Business");
  return business;
}

async function loadVenue(id: string) {
  const venue = await VenueModel.findById(id);
  if (!venue) throw notFound("Venue");
  return venue;
}

export async function approveBusiness(admin: AuthUser, id: string) {
  const business = await loadBusiness(id);
  await setBusinessStatus(business, "active");
  await audit(admin.id, "business.approve", "business", id);
  return business;
}

export async function rejectBusiness(admin: AuthUser, id: string, reason: string) {
  const business = await loadBusiness(id);
  if (business.status === "active") {
    throw new HttpError(409, "CONFLICT", "Business is active; suspend it instead");
  }
  await setBusinessStatus(business, "draft", reason);
  await audit(admin.id, "business.reject", "business", id, { reason });
  return business;
}

export async function suspendBusiness(admin: AuthUser, id: string, reason: string) {
  const business = await loadBusiness(id);
  await setBusinessStatus(business, "suspended", reason);
  await audit(admin.id, "business.suspend", "business", id, { reason });
  return business;
}

/** Approving a venue also activates its business when that is still awaiting review. */
export async function approveVenue(admin: AuthUser, id: string) {
  const venue = await loadVenue(id);
  if (venue.status !== "pending_review" && venue.status !== "hidden") {
    throw new HttpError(409, "CONFLICT", `Venue is ${venue.status}`);
  }
  const business = await loadBusiness(String(venue.businessId));
  if (business.status === "suspended") {
    throw new HttpError(409, "CONFLICT", "Business is suspended");
  }
  if (business.status !== "active") {
    await setBusinessStatus(business, "active");
    await audit(admin.id, "business.approve", "business", String(business._id), { via: id });
  }
  venue.status = "live";
  venue.reviewNote = undefined;
  venue.businessActive = true;
  await venue.save();
  await audit(admin.id, "venue.approve", "venue", id);
  return venue;
}

export async function rejectVenue(admin: AuthUser, id: string, reason: string) {
  const venue = await loadVenue(id);
  if (venue.status !== "pending_review") {
    throw new HttpError(409, "CONFLICT", `Venue is ${venue.status}`);
  }
  venue.status = "draft";
  venue.reviewNote = reason;
  await venue.save();
  await audit(admin.id, "venue.reject", "venue", id, { reason });
  return venue;
}

export async function hideVenue(admin: AuthUser, id: string, reason: string) {
  const venue = await loadVenue(id);
  venue.status = "hidden";
  venue.reviewNote = reason;
  await venue.save();
  await audit(admin.id, "venue.hide", "venue", id, { reason });
  return venue;
}

/** Approving an event publishes it (and activates its business when still in review). */
export async function approveEvent(admin: AuthUser, id: string) {
  const event = await EventModel.findById(id);
  if (!event) throw notFound("Event");
  if (event.status !== "pending_review")
    throw new HttpError(409, "CONFLICT", `Event is ${event.status}`);
  const business = await loadBusiness(String(event.businessId));
  if (business.status === "suspended")
    throw new HttpError(409, "CONFLICT", "Business is suspended");
  if (business.status !== "active") {
    await setBusinessStatus(business, "active");
    await audit(admin.id, "business.approve", "business", String(business._id), { via: id });
  }
  event.status = "published";
  event.reviewNote = undefined;
  event.businessActive = true;
  await event.save();
  await audit(admin.id, "event.approve", "event", id);
  return event;
}

export async function rejectEvent(admin: AuthUser, id: string, reason: string) {
  const event = await EventModel.findById(id);
  if (!event) throw notFound("Event");
  if (event.status !== "pending_review")
    throw new HttpError(409, "CONFLICT", `Event is ${event.status}`);
  event.status = "draft";
  event.reviewNote = reason;
  await event.save();
  await audit(admin.id, "event.reject", "event", id, { reason });
  return event;
}

export async function reviewQueue(
  kind: "business" | "venue" | "event",
  status: string,
): Promise<ReviewQueueItem[]> {
  const allowed: readonly string[] =
    kind === "business" ? BUSINESS_STATUSES : kind === "venue" ? VENUE_STATUSES : EVENT_STATUSES;
  if (!allowed.includes(status)) {
    throw new HttpError(400, "VALIDATION_FAILED", `Unknown ${kind} status`, { status });
  }
  if (kind === "event") {
    const events = await EventModel.find({ status: status as EventStatus })
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean();
    const owners = await BusinessModel.find(
      { _id: { $in: events.map((e) => e.businessId) } },
      { name: 1 },
    ).lean();
    const names = new Map(owners.map((b) => [String(b._id), b.name]));
    return events.map((e) => ({
      kind,
      id: String(e._id),
      name: e.title,
      status: e.status,
      businessName: names.get(String(e.businessId)) ?? "",
      citySlug: e.citySlug,
      slug: e.slug,
      reviewNote: e.reviewNote ?? null,
      updatedAt: e.updatedAt.toISOString(),
    }));
  }
  if (kind === "business") {
    const items = await BusinessModel.find({ status: status as BusinessStatus })
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean();
    return items.map((b) => ({
      kind,
      id: String(b._id),
      name: b.name,
      status: b.status,
      businessName: b.name,
      citySlug: null,
      slug: null,
      reviewNote: b.reviewNote ?? null,
      updatedAt: b.updatedAt.toISOString(),
    }));
  }
  const venues = await VenueModel.find({ status: status as VenueStatus })
    .sort({ updatedAt: 1 })
    .limit(200)
    .lean();
  const businesses = await BusinessModel.find(
    { _id: { $in: venues.map((v) => v.businessId) } },
    { name: 1 },
  ).lean();
  const names = new Map(businesses.map((b) => [String(b._id), b.name]));
  return venues.map((v) => ({
    kind,
    id: String(v._id),
    name: v.name,
    status: v.status,
    businessName: names.get(String(v.businessId)) ?? "",
    citySlug: v.citySlug,
    slug: v.slug,
    reviewNote: v.reviewNote ?? null,
    updatedAt: v.updatedAt.toISOString(),
  }));
}
