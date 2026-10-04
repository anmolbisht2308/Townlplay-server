import type {
  Business,
  PayoutInfo,
  Photo,
  PublicVenue,
  Resource,
  Venue,
  VenueCard,
} from "@townplay/shared";
import type { BusinessRaw } from "../models/business.js";
import type { ResourceRaw } from "../models/resource.js";
import type { VenueRaw } from "../models/venue.js";

// Hydrated docs and lean objects both satisfy these.
type BusinessLike = BusinessRaw;
type VenueLike = VenueRaw;
type ResourceLike = ResourceRaw;

const photos = (v: VenueLike): Photo[] =>
  v.photos.map((p) => ({ url: p.url ?? "", publicId: p.publicId ?? "" }));

export function toBusiness(b: BusinessLike): Business {
  return {
    id: String(b._id),
    name: b.name,
    type: b.type,
    contactPhone: b.contactPhone,
    email: b.email,
    kyc: {
      legalName: b.kyc?.legalName ?? "",
      ...(b.kyc?.pan ? { pan: b.kyc.pan } : {}),
      ...(b.kyc?.gstin ? { gstin: b.kyc.gstin } : {}),
    },
    status: b.status,
    reviewNote: b.reviewNote ?? null,
    payout: toPayoutInfo(b),
    createdAt: b.createdAt.toISOString(),
  };
}

/** Payout setup without secrets (no full account number). */
export function toPayoutInfo(b: BusinessLike, mode: "route" | "manual" = payoutsMode): PayoutInfo {
  return {
    mode,
    status: b.payout?.status ?? "not_started",
    accountHolderName: b.payout?.accountHolderName ?? null,
    accountLast4: b.payout?.accountLast4 ?? null,
    ifsc: b.payout?.ifsc ?? null,
  };
}

let payoutsMode: "route" | "manual" = "manual";
/** Set once at startup from PAYOUTS_MODE so DTOs report it. */
export function setPayoutsMode(mode: "route" | "manual") {
  payoutsMode = mode;
}

export function toVenue(v: VenueLike): Venue {
  const [lng = 0, lat = 0] = v.geo?.coordinates ?? [];
  return {
    id: String(v._id),
    businessId: String(v.businessId),
    citySlug: v.citySlug,
    slug: v.slug,
    name: v.name,
    category: v.category,
    sports: v.sports,
    amenities: v.amenities,
    description: v.description,
    address: v.address,
    area: v.area,
    location: { lat, lng },
    photos: photos(v),
    openingHours: v.openingHours.map((d) => ({
      open: d.open,
      close: d.close,
      closed: Boolean(d.closed),
    })),
    bookingPolicy: {
      advancePercent: v.bookingPolicy?.advancePercent ?? 0,
      cancellationCutoffHours: v.bookingPolicy?.cancellationCutoffHours ?? 0,
      refundPercentBeforeCutoff: v.bookingPolicy?.refundPercentBeforeCutoff ?? 0,
    },
    status: v.status,
    reviewNote: v.reviewNote ?? null,
    updatedAt: v.updatedAt.toISOString(),
  };
}

export function toResource(r: ResourceLike): Resource {
  return {
    id: String(r._id),
    venueId: String(r.venueId),
    name: r.name,
    sport: r.sport,
    slotDurationMins: r.slotDurationMins,
    maxPlayers: r.maxPlayers,
    pricingRules: r.pricingRules.map((p) => ({
      days: [...p.days],
      start: p.start,
      end: p.end,
      pricePaise: p.pricePaise,
    })),
    isActive: r.isActive,
  };
}

export function toVenueCard(v: VenueLike & { distance?: number }): VenueCard {
  return {
    id: String(v._id),
    slug: v.slug,
    name: v.name,
    category: v.category,
    area: v.area,
    sports: v.sports,
    photo: photos(v)[0] ?? null,
    minPricePaise: v.minPricePaise ?? null,
    distanceKm: v.distance === undefined ? null : Math.round(v.distance / 100) / 10,
  };
}

export function toPublicVenue(
  v: VenueLike,
  extra: { cityName: string; contactPhone: string; resources: ResourceLike[] },
): PublicVenue {
  const { businessId: _b, status: _s, reviewNote: _r, ...rest } = toVenue(v);
  return {
    ...rest,
    cityName: extra.cityName,
    contactPhone: extra.contactPhone,
    resources: extra.resources.map((r) => {
      const { isActive: _a, ...pub } = toResource(r);
      return pub;
    }),
  };
}
