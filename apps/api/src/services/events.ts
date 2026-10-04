import {
  eventWindow,
  type CreateEvent,
  type Event,
  type EventCard,
  type EventListQuery,
  type PublicEvent,
  type TierInput,
  type UpdateEvent,
} from "@townplay/shared";
import { Types } from "mongoose";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BusinessModel } from "../models/business.js";
import { CityModel } from "../models/city.js";
import { EventModel, type EventDoc, type EventRaw } from "../models/event.js";
import { VenueModel } from "../models/venue.js";
import { audit } from "./audit.js";
import { loadOwnedBusiness } from "./listings.js";
import { isOwnPhotoUrl, type CloudinaryConfig } from "./uploads.js";

const oid = (id: string) => new Types.ObjectId(id);

function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "event"
  );
}

async function uniqueSlug(cityId: Types.ObjectId, title: string, startsAt: Date) {
  // Recurring events (weekly club sessions) share titles; the date keeps slugs readable.
  const base = `${slugify(title)}-${startsAt.toISOString().slice(0, 10)}`;
  const taken = new Set(
    (
      await EventModel.find({ cityId, slug: { $regex: `^${base}(-\\d+)?$` } }, { slug: 1 }).lean()
    ).map((e) => e.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function toEvent(e: EventRaw | EventDoc, venueName: string | null = null): Event {
  const [lng = 0, lat = 0] = e.geo?.coordinates ?? [];
  return {
    id: String(e._id),
    businessId: String(e.businessId),
    citySlug: e.citySlug,
    slug: e.slug,
    title: e.title,
    type: e.type,
    description: e.description,
    photos: e.photos.map((p) => ({ url: p.url ?? "", publicId: p.publicId ?? "" })),
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    venueId: e.venueId ? String(e.venueId) : null,
    venueName,
    address: e.address,
    location: { lat, lng },
    ageLimit: e.ageLimit ?? null,
    tiers: e.tiers.map((t) => ({
      id: String(t._id),
      name: t.name,
      pricePaise: t.pricePaise,
      capacity: t.capacity,
      remaining: t.remaining,
    })),
    status: e.status,
    reviewNote: e.reviewNote ?? null,
    updatedAt: e.updatedAt.toISOString(),
  };
}

export function toEventCard(e: EventRaw, venueName: string | null): EventCard {
  return {
    id: String(e._id),
    slug: e.slug,
    title: e.title,
    type: e.type,
    startsAt: e.startsAt.toISOString(),
    venueName,
    area: e.area ?? "",
    photo: e.photos[0]
      ? { url: e.photos[0].url ?? "", publicId: e.photos[0].publicId ?? "" }
      : null,
    minPricePaise: Math.min(...e.tiers.map((t) => t.pricePaise)),
    soldOut: e.tiers.every((t) => t.remaining <= 0),
  };
}

export async function loadOwnedEvent(user: AuthUser, id: string): Promise<EventDoc> {
  const event = await EventModel.findById(id);
  if (!event) throw notFound("Event");
  try {
    await loadOwnedBusiness(user, String(event.businessId));
  } catch {
    throw notFound("Event");
  }
  return event;
}

export function createEventService(deps: {
  cloudinary: CloudinaryConfig | undefined;
  now?: () => Date;
}) {
  const { cloudinary, now = () => new Date() } = deps;

  function checkPhotos(photos: { url: string }[] | undefined) {
    const bad = photos?.find((p) => !isOwnPhotoUrl(cloudinary, p.url));
    if (bad)
      throw new HttpError(400, "VALIDATION_FAILED", "Photos must be uploaded through Townplay");
  }

  /** Address and pin come from the venue when the event is hosted at one of the business's venues. */
  async function place(
    businessId: Types.ObjectId,
    input: Pick<UpdateEvent, "venueId" | "address" | "location">,
  ) {
    if (input.venueId) {
      const venue = await VenueModel.findOne({ _id: oid(input.venueId), businessId }).lean();
      if (!venue)
        throw new HttpError(400, "VALIDATION_FAILED", "Unknown venue", { venueId: input.venueId });
      return { venueId: venue._id, address: venue.address, area: venue.area, geo: venue.geo };
    }
    if (!input.address || !input.location) return null;
    return {
      venueId: undefined,
      address: input.address,
      area: "",
      geo: { type: "Point" as const, coordinates: [input.location.lng, input.location.lat] },
    };
  }

  function newTiers(tiers: TierInput[]) {
    return tiers.map((t) => ({
      name: t.name,
      pricePaise: t.pricePaise,
      capacity: t.capacity,
      remaining: t.capacity,
    }));
  }

  async function create(user: AuthUser, input: CreateEvent) {
    const business = await loadOwnedBusiness(user, input.businessId);
    const city = await CityModel.findOne({ slug: input.citySlug, isActive: true });
    if (!city) throw new HttpError(400, "VALIDATION_FAILED", "Unknown city");
    checkPhotos(input.photos);
    const where = await place(business._id, input);
    if (!where)
      throw new HttpError(400, "VALIDATION_FAILED", "Pick a venue or enter an address and map pin");
    const startsAt = new Date(input.startsAt);
    const event = await EventModel.create({
      businessId: business._id,
      cityId: city._id,
      citySlug: city.slug,
      ...where,
      title: input.title,
      slug: await uniqueSlug(city._id, input.title, startsAt),
      type: input.type,
      description: input.description,
      photos: input.photos,
      startsAt,
      endsAt: new Date(input.endsAt),
      ageLimit: input.ageLimit ?? undefined,
      tiers: newTiers(input.tiers),
      status: "draft",
      businessActive: business.status === "active",
    });
    await audit(user.id, "event.create", "event", String(event._id));
    return event;
  }

  /**
   * Tier edits never lose sold tickets: capacity changes move `remaining` by the same delta (and
   * may not go below what is sold or held); tiers with sales cannot be removed.
   */
  async function update(user: AuthUser, id: string, input: UpdateEvent) {
    const event = await loadOwnedEvent(user, id);
    if (event.status === "cancelled" || event.status === "completed") {
      throw new HttpError(409, "CONFLICT", `Event is ${event.status}`);
    }
    checkPhotos(input.photos);
    const { tiers, venueId, address, location, startsAt, endsAt, ageLimit, ...rest } = input;
    event.set(rest);
    if (startsAt) event.startsAt = new Date(startsAt);
    if (endsAt) event.endsAt = new Date(endsAt);
    if (event.endsAt <= event.startsAt)
      throw new HttpError(400, "VALIDATION_FAILED", "End must be after start");
    if (ageLimit !== undefined) event.set("ageLimit", ageLimit ?? undefined);
    if (venueId !== undefined || address !== undefined || location !== undefined) {
      const where = await place(event.businessId, {
        venueId: venueId === undefined ? (event.venueId ? String(event.venueId) : null) : venueId,
        address: address ?? event.address,
        location: location ?? null,
      });
      if (!where)
        throw new HttpError(
          400,
          "VALIDATION_FAILED",
          "Pick a venue or enter an address and map pin",
        );
      event.set(where);
    }
    if (tiers) {
      const next = [];
      for (const t of tiers) {
        const existing = t.id ? event.tiers.id(t.id) : null;
        if (t.id && !existing)
          throw new HttpError(400, "VALIDATION_FAILED", "Unknown tier", { tierId: t.id });
        if (!existing) {
          next.push({
            name: t.name,
            pricePaise: t.pricePaise,
            capacity: t.capacity,
            remaining: t.capacity,
          });
          continue;
        }
        const taken = existing.capacity - existing.remaining;
        if (t.capacity < taken) {
          throw new HttpError(
            409,
            "TIER_OVERSOLD",
            `${existing.name}: ${taken} tickets are already sold or held`,
          );
        }
        if (taken > 0 && t.pricePaise !== existing.pricePaise) {
          throw new HttpError(
            409,
            "CONFLICT",
            `${existing.name}: price cannot change after sales start`,
          );
        }
        next.push({
          _id: existing._id,
          name: t.name,
          pricePaise: t.pricePaise,
          capacity: t.capacity,
          remaining: existing.remaining + (t.capacity - existing.capacity),
        });
      }
      for (const old of event.tiers) {
        const kept = next.some((t) => "_id" in t && String(t._id) === String(old._id));
        if (!kept && old.capacity !== old.remaining) {
          throw new HttpError(409, "CONFLICT", `${old.name} has sales and cannot be removed`);
        }
      }
      event.set("tiers", next);
    }
    await event.save();
    await audit(user.id, "event.update", "event", id, { fields: Object.keys(input) });
    return event;
  }

  async function submit(user: AuthUser, id: string) {
    const event = await loadOwnedEvent(user, id);
    if (event.status !== "draft") throw new HttpError(409, "CONFLICT", `Event is ${event.status}`);
    if (event.startsAt <= now()) throw new HttpError(409, "CONFLICT", "Event start is in the past");
    const business = await BusinessModel.findById(event.businessId);
    if (business?.status === "suspended")
      throw new HttpError(409, "CONFLICT", "Business is suspended");
    event.status = "pending_review";
    event.reviewNote = undefined;
    await event.save();
    if (business?.status === "draft") {
      business.status = "pending_review";
      await business.save();
    }
    await audit(user.id, "event.submit", "event", id);
    return event;
  }

  async function listMine(user: AuthUser) {
    const businesses = await BusinessModel.find({ ownerUserIds: oid(user.id) }, { _id: 1 }).lean();
    return EventModel.find({ businessId: { $in: businesses.map((b) => b._id) } }).sort({
      startsAt: -1,
    });
  }

  async function venueNames(events: EventRaw[]) {
    const ids = events.map((e) => e.venueId).filter((v): v is Types.ObjectId => Boolean(v));
    const venues = await VenueModel.find({ _id: { $in: ids } }, { name: 1 }).lean();
    return new Map(venues.map((v) => [String(v._id), v.name]));
  }

  async function list(
    citySlug: string,
    q: EventListQuery,
  ): Promise<{ items: EventCard[]; nextCursor: string | null }> {
    const city = await CityModel.findOne({ slug: citySlug, isActive: true }).lean();
    if (!city) throw notFound("City");
    const offset = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) || 0 : 0;
    const { from, to } = eventWindow(q.when, now());
    const rows = await EventModel.find({
      cityId: city._id,
      status: "published",
      businessActive: true,
      endsAt: { $gt: from },
      ...(to ? { startsAt: { $lt: to } } : {}),
      ...(q.type ? { type: q.type } : {}),
    })
      .sort({ startsAt: 1, _id: 1 })
      .skip(offset)
      .limit(q.limit + 1)
      .lean();
    const names = await venueNames(rows);
    return {
      items: rows
        .slice(0, q.limit)
        .map((e) => toEventCard(e, e.venueId ? (names.get(String(e.venueId)) ?? null) : null)),
      nextCursor:
        rows.length > q.limit ? Buffer.from(String(offset + q.limit)).toString("base64url") : null,
    };
  }

  async function bySlug(citySlug: string, slug: string): Promise<PublicEvent> {
    const city = await CityModel.findOne({ slug: citySlug, isActive: true }).lean();
    if (!city) throw notFound("City");
    const event = await EventModel.findOne({
      cityId: city._id,
      slug,
      status: { $in: ["published", "cancelled", "completed"] },
      businessActive: true,
    }).lean();
    if (!event) throw notFound("Event");
    const [names, business] = await Promise.all([
      venueNames([event]),
      BusinessModel.findById(event.businessId, { name: 1, contactPhone: 1 }).lean(),
    ]);
    const {
      businessId: _b,
      status,
      reviewNote: _r,
      ...rest
    } = toEvent(event, event.venueId ? (names.get(String(event.venueId)) ?? null) : null);
    return {
      ...rest,
      cityName: city.name,
      organiserName: business?.name ?? "",
      contactPhone: business?.contactPhone ?? "",
      cancelled: status === "cancelled",
    };
  }

  async function sitemap() {
    const rows = await EventModel.find(
      { status: "published", businessActive: true, endsAt: { $gt: now() } },
      { citySlug: 1, slug: 1, updatedAt: 1 },
    ).lean();
    return rows.map((e) => ({
      citySlug: e.citySlug,
      slug: e.slug,
      updatedAt: e.updatedAt.toISOString(),
    }));
  }

  /** Published events whose end has passed become completed (job). */
  async function completeFinished() {
    const res = await EventModel.updateMany(
      { status: "published", endsAt: { $lte: now() } },
      { $set: { status: "completed" } },
    );
    return res.modifiedCount;
  }

  return { create, update, submit, listMine, list, bySlug, sitemap, completeFinished, venueNames };
}

export type EventService = ReturnType<typeof createEventService>;
