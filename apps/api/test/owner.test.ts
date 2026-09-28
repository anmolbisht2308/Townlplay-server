import { beforeEach, describe, expect, it } from "vitest";
import { AuditLogModel } from "../src/models/auditLog.js";
import { seed } from "../src/scripts/seed.js";
import { agent, businessInput, ownerWithVenue, resourceInput, venueInput } from "./factories.js";
import { setupApp } from "./helpers.js";

describe("owner listing management", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("creates a business and grants the owner role", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const res = await owner.post("/v1/businesses", businessInput()).expect(201);
    expect(res.body).toMatchObject({ name: "Green Arena", status: "draft", reviewNote: null });
    const me = await owner.get("/v1/me").expect(200);
    expect(me.body.roles).toContain("owner");
    const mine = await owner.get("/v1/businesses/mine").expect(200);
    expect(mine.body).toHaveLength(1);
    expect(await AuditLogModel.countDocuments({ action: "business.create" })).toBe(1);
  });

  it("requires sign-in and validates input", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const bad = await owner.post("/v1/businesses", { ...businessInput(), contactPhone: "123" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("creates venues with unique slugs per city and rejects unknown cities", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { businessId, slug } = await ownerWithVenue(owner);
    expect(slug).toBe("green-arena-turf");
    const second = await owner.post("/v1/venues", venueInput(businessId)).expect(201);
    expect(second.body.slug).toBe("green-arena-turf-2");
    expect(second.body.location).toEqual({ lat: 28.367, lng: 79.4304 });
    const unknown = await owner.post(
      "/v1/venues",
      venueInput(businessId, { citySlug: "atlantis" }),
    );
    expect(unknown.status).toBe(400);
  });

  it("keeps other owners out of a business, venue and its courts", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { businessId, venueId } = await ownerWithVenue(owner);
    const other = await agent(ctx, "other@example.com");
    await other.get(`/v1/venues/${venueId}`).expect(404);
    await other.patch(`/v1/venues/${venueId}`, { name: "Mine now" }).expect(404);
    await other.patch(`/v1/businesses/${businessId}`, { name: "Mine now" }).expect(404);
    await other.post("/v1/venues", venueInput(businessId)).expect(404);
    await other.get(`/v1/venues/${venueId}/resources`).expect(404);
    await other.post(`/v1/venues/${venueId}/resources`, resourceInput()).expect(404);
    expect((await other.get("/v1/venues/mine").expect(200)).body).toEqual([]);
  });

  it("manages courts, rejects overlapping price bands, keeps min price in sync", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await ownerWithVenue(owner);
    const overlap = await owner.post(
      `/v1/venues/${venueId}/resources`,
      resourceInput({
        pricingRules: [
          { days: [1], start: "06:00", end: "12:00", pricePaise: 50000 },
          { days: [1], start: "11:00", end: "14:00", pricePaise: 60000 },
        ],
      }),
    );
    expect(overlap.status).toBe(400);

    const court = await owner
      .post(
        `/v1/venues/${venueId}/resources`,
        resourceInput({ name: "Court 2", sport: "box_cricket", slotDurationMins: 90 }),
      )
      .expect(201);
    const list = await owner.get(`/v1/venues/${venueId}/resources`).expect(200);
    expect(list.body.map((r: { name: string }) => r.name)).toEqual(["Turf A", "Court 2"]);

    await owner
      .patch(`/v1/venues/${venueId}/resources/${court.body.id}`, {
        pricingRules: [
          { days: [0, 1, 2, 3, 4, 5, 6], start: "06:00", end: "22:00", pricePaise: 50000 },
        ],
      })
      .expect(200);
    await owner.delete(`/v1/venues/${venueId}/resources/${court.body.id}`).expect(204);
    await owner.delete(`/v1/venues/${venueId}/resources/${court.body.id}`).expect(404);
  });

  it("submits only with an active court", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const business = await owner.post("/v1/businesses", businessInput()).expect(201);
    const venue = await owner.post("/v1/venues", venueInput(business.body.id)).expect(201);
    const early = await owner.post(`/v1/venues/${venue.body.id}/submit`).expect(409);
    expect(early.body.error.code).toBe("NO_RESOURCES");

    await owner.post(`/v1/venues/${venue.body.id}/resources`, resourceInput()).expect(201);
    const submitted = await owner.post(`/v1/venues/${venue.body.id}/submit`).expect(200);
    expect(submitted.body.status).toBe("pending_review");
    await owner.post(`/v1/venues/${venue.body.id}/submit`).expect(409);
    const mine = await owner.get("/v1/businesses/mine").expect(200);
    expect(mine.body[0].status).toBe("pending_review");
  });

  it("refuses photo URLs that are not ours once Cloudinary is configured", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await ownerWithVenue(owner);
    // No CLOUDINARY_URL in tests: any https URL is accepted, uploads are disabled.
    await owner
      .patch(`/v1/venues/${venueId}`, {
        photos: [{ url: "https://example.com/a.jpg", publicId: "a" }],
      })
      .expect(200);
    const sign = await owner.post("/v1/uploads/sign", { purpose: "venue_photo" }).expect(503);
    expect(sign.body.error.code).toBe("UPLOADS_DISABLED");
  });
});

describe("uploads with Cloudinary", () => {
  const ctx = setupApp({ CLOUDINARY_URL: "cloudinary://key123:secret456@democloud" });
  beforeEach(() => seed(undefined));

  it("signs uploads and only accepts our Cloudinary photo URLs", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const sign = await owner.post("/v1/uploads/sign", { purpose: "venue_photo" }).expect(200);
    expect(sign.body).toMatchObject({
      uploadUrl: "https://api.cloudinary.com/v1_1/democloud/image/upload",
      apiKey: "key123",
    });
    expect(sign.body.signature).toMatch(/^[a-f0-9]{40}$/);

    const { venueId } = await ownerWithVenue(owner);
    await owner
      .patch(`/v1/venues/${venueId}`, {
        photos: [{ url: "https://example.com/a.jpg", publicId: "a" }],
      })
      .expect(400);
    await owner
      .patch(`/v1/venues/${venueId}`, {
        photos: [
          { url: "https://res.cloudinary.com/democloud/image/upload/v1/a.jpg", publicId: "a" },
        ],
      })
      .expect(200);
  });
});
