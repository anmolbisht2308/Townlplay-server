import type { CreateBusiness, CreateResource } from "@townplay/shared";
import request from "supertest";
import { seed } from "../src/scripts/seed.js";
import type { setupApp } from "./helpers.js";
import { WEB_ORIGIN, signInWithOtp } from "./helpers.js";

type Ctx = ReturnType<typeof setupApp>;

export async function agent(ctx: Ctx, email: string) {
  const cookies = await signInWithOtp(ctx, email);
  const as = (r: request.Test) => r.set("Cookie", cookies).set("Origin", WEB_ORIGIN);
  return {
    get: (path: string) => as(request(ctx.app).get(path)),
    post: (path: string, body?: object) => as(request(ctx.app).post(path)).send(body ?? {}),
    patch: (path: string, body: object) => as(request(ctx.app).patch(path)).send(body),
    delete: (path: string) => as(request(ctx.app).delete(path)),
  };
}

export async function adminAgent(ctx: Ctx) {
  await seed("admin@example.com");
  return agent(ctx, "admin@example.com");
}

export const businessInput = (over: Partial<CreateBusiness> = {}): CreateBusiness => ({
  name: "Green Arena",
  type: "sports",
  contactPhone: "9876543210",
  email: "owner@greenarena.in",
  kyc: { legalName: "Green Arena LLP" },
  ...over,
});

const day = { open: "06:00", close: "23:00", closed: false };

export const venueInput = (businessId: string, over: Record<string, unknown> = {}) => ({
  businessId,
  citySlug: "bareilly",
  name: "Green Arena Turf",
  category: "sports",
  sports: ["football", "box_cricket"],
  amenities: ["parking", "floodlights"],
  description: "Two 5-a-side turfs near Civil Lines.",
  address: "12 Civil Lines, Bareilly",
  area: "Civil Lines",
  location: { lat: 28.367, lng: 79.4304 },
  photos: [],
  openingHours: Array(7).fill(day),
  bookingPolicy: { advancePercent: 30, cancellationCutoffHours: 6, refundPercentBeforeCutoff: 100 },
  ...over,
});

export const resourceInput = (over: Partial<CreateResource> = {}): CreateResource => ({
  name: "Turf A",
  sport: "football",
  slotDurationMins: 60,
  maxPlayers: 14,
  isActive: true,
  pricingRules: [
    { days: [1, 2, 3, 4, 5], start: "06:00", end: "17:00", pricePaise: 80000 },
    { days: [1, 2, 3, 4, 5], start: "17:00", end: "24:00", pricePaise: 120000 },
    { days: [0, 6], start: "06:00", end: "24:00", pricePaise: 150000 },
  ],
  ...over,
});

type Agent = Awaited<ReturnType<typeof agent>>;

/** Owner with a business, a venue and one court; returns ids. */
export async function ownerWithVenue(owner: Agent, over: Record<string, unknown> = {}) {
  const business = await owner.post("/v1/businesses", businessInput()).expect(201);
  const venue = await owner.post("/v1/venues", venueInput(business.body.id, over)).expect(201);
  await owner.post(`/v1/venues/${venue.body.id}/resources`, resourceInput()).expect(201);
  return {
    businessId: business.body.id as string,
    venueId: venue.body.id as string,
    slug: venue.body.slug as string,
  };
}

/** Owner venue submitted and approved by admin. */
export async function liveVenue(ctx: Ctx, owner: Agent, over: Record<string, unknown> = {}) {
  const ids = await ownerWithVenue(owner, over);
  await owner.post(`/v1/venues/${ids.venueId}/submit`).expect(200);
  const admin = await adminAgent(ctx);
  await admin.post(`/v1/admin/venues/${ids.venueId}/approve`).expect(200);
  return ids;
}
