import type { SitemapEntry, VenueListQuery, VenueListResponse } from "@townplay/shared";
import type { PipelineStage, QueryFilter } from "mongoose";
import { notFound } from "../lib/httpError.js";
import { toPublicVenue, toVenueCard } from "../lib/dto.js";
import { BusinessModel } from "../models/business.js";
import { CityModel } from "../models/city.js";
import { ResourceModel } from "../models/resource.js";
import { VenueModel, type VenueRaw } from "../models/venue.js";

type VenueFilter = QueryFilter<VenueRaw>;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Opaque offset cursor. */
const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function activeCity(slug: string) {
  const city = await CityModel.findOne({ slug, isActive: true }).lean();
  if (!city) throw notFound("City");
  return city;
}

export async function listVenues(citySlug: string, q: VenueListQuery): Promise<VenueListResponse> {
  const city = await activeCity(citySlug);
  const offset = decodeCursor(q.cursor);
  const filter: VenueFilter = { cityId: city._id, status: "live", businessActive: true };
  if (q.category) filter.category = q.category;
  if (q.sport) filter.sports = q.sport;
  if (q.area) filter.area = { $regex: `^${escapeRegex(q.area)}$`, $options: "i" };

  const regexSearch = (text: string): VenueFilter => {
    const re = { $regex: escapeRegex(text), $options: "i" };
    return { $or: [{ name: re }, { area: re }, { sports: re }] };
  };

  let rows: (VenueRaw & { distance?: number })[];
  if (q.near) {
    const [lat, lng] = q.near.split(",").map(Number) as [number, number];
    const pipeline: PipelineStage[] = [
      {
        $geoNear: {
          near: { type: "Point", coordinates: [lng, lat] },
          distanceField: "distance",
          spherical: true,
          query: q.q ? { ...filter, ...regexSearch(q.q) } : filter,
        },
      },
      { $skip: offset },
      { $limit: q.limit + 1 },
    ];
    rows = await VenueModel.aggregate<VenueRaw & { distance: number }>(pipeline);
  } else if (q.q) {
    rows = await VenueModel.find(
      { ...filter, $text: { $search: q.q } },
      { score: { $meta: "textScore" } },
    )
      .sort({ score: { $meta: "textScore" } })
      .skip(offset)
      .limit(q.limit + 1)
      .lean();
    // $text only matches whole words; fall back to a substring match ("tur" → "Turf").
    if (rows.length === 0 && offset === 0) {
      rows = await VenueModel.find({ ...filter, ...regexSearch(q.q) })
        .sort({ name: 1 })
        .limit(q.limit + 1)
        .lean();
    }
  } else {
    rows = await VenueModel.find(filter)
      .sort({ name: 1, _id: 1 })
      .skip(offset)
      .limit(q.limit + 1)
      .lean();
  }

  const hasMore = rows.length > q.limit;
  return {
    items: rows.slice(0, q.limit).map(toVenueCard),
    nextCursor: hasMore ? encodeCursor(offset + q.limit) : null,
  };
}

export async function listAreas(citySlug: string): Promise<string[]> {
  const city = await activeCity(citySlug);
  const areas = await VenueModel.distinct("area", {
    cityId: city._id,
    status: "live",
    businessActive: true,
  });
  return areas.sort((a, b) => a.localeCompare(b));
}

export async function getPublicVenue(citySlug: string, slug: string) {
  const city = await activeCity(citySlug);
  const venue = await VenueModel.findOne({
    cityId: city._id,
    slug,
    status: "live",
    businessActive: true,
  }).lean();
  if (!venue) throw notFound("Venue");
  const [business, resources] = await Promise.all([
    BusinessModel.findById(venue.businessId, { contactPhone: 1 }).lean(),
    ResourceModel.find({ venueId: venue._id, isActive: true }).sort({ name: 1 }).lean(),
  ]);
  return toPublicVenue(venue, {
    cityName: city.name,
    contactPhone: business?.contactPhone ?? "",
    resources,
  });
}

export async function sitemapEntries(): Promise<SitemapEntry[]> {
  const venues = await VenueModel.find(
    { status: "live", businessActive: true },
    { citySlug: 1, slug: 1, updatedAt: 1 },
  )
    .limit(50_000)
    .lean();
  return venues.map((v) => ({
    citySlug: v.citySlug,
    slug: v.slug,
    updatedAt: v.updatedAt.toISOString(),
  }));
}
