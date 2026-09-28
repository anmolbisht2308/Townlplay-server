import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { seed } from "../src/scripts/seed.js";
import { adminAgent, agent, liveVenue, ownerWithVenue } from "./factories.js";
import { setupApp } from "./helpers.js";

describe("public listing", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("lists cities", async () => {
    const res = await request(ctx.app).get("/v1/cities").expect(200);
    expect(res.body).toEqual([expect.objectContaining({ slug: "bareilly", name: "Bareilly" })]);
    await request(ctx.app).get("/v1/cities/atlantis/venues").expect(404);
  });

  it("shows only live venues of active businesses, with filters and search", async () => {
    const owner = await agent(ctx, "owner@example.com");
    await liveVenue(ctx, owner);
    await liveVenue(ctx, owner, {
      name: "Shuttle Point",
      sports: ["badminton"],
      area: "Rajendra Nagar",
      location: { lat: 28.39, lng: 79.45 },
    });
    await ownerWithVenue(owner, { name: "Draft Turf" }); // never submitted

    const all = await request(ctx.app).get("/v1/cities/bareilly/venues").expect(200);
    expect(all.body.items.map((v: { name: string }) => v.name)).toEqual([
      "Green Arena Turf",
      "Shuttle Point",
    ]);
    expect(all.body.items[0]).toMatchObject({
      minPricePaise: 80000,
      area: "Civil Lines",
      distanceKm: null,
    });

    const q = (qs: string) =>
      request(ctx.app)
        .get(`/v1/cities/bareilly/venues?${qs}`)
        .expect(200)
        .then((r) => r.body.items.map((v: { name: string }) => v.name));
    expect(await q("sport=badminton")).toEqual(["Shuttle Point"]);
    expect(await q("area=civil%20lines")).toEqual(["Green Arena Turf"]);
    expect(await q("q=shuttle")).toEqual(["Shuttle Point"]);
    expect(await q("q=shut")).toEqual(["Shuttle Point"]);
    expect(await q("category=club")).toEqual([]);
    // Nearest first from a point next to Shuttle Point.
    expect(await q("near=28.391,79.451")).toEqual(["Shuttle Point", "Green Arena Turf"]);

    const page1 = await request(ctx.app).get("/v1/cities/bareilly/venues?limit=1").expect(200);
    expect(page1.body.items).toHaveLength(1);
    const page2 = await request(ctx.app)
      .get(`/v1/cities/bareilly/venues?limit=1&cursor=${page1.body.nextCursor}`)
      .expect(200);
    expect(page2.body.items[0].name).toBe("Shuttle Point");
    expect(page2.body.nextCursor).toBeNull();

    const areas = await request(ctx.app).get("/v1/cities/bareilly/areas").expect(200);
    expect(areas.body).toEqual(["Civil Lines", "Rajendra Nagar"]);

    await request(ctx.app).get("/v1/cities/bareilly/venues?near=nowhere").expect(400);
  });

  it("serves the venue page and hides it once the business is suspended", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { slug, businessId } = await liveVenue(ctx, owner);
    const res = await request(ctx.app).get(`/v1/venues/by-slug/bareilly/${slug}`).expect(200);
    expect(res.body).toMatchObject({
      name: "Green Arena Turf",
      cityName: "Bareilly",
      contactPhone: "9876543210",
      resources: [expect.objectContaining({ name: "Turf A", slotDurationMins: 60 })],
    });
    expect(res.body).not.toHaveProperty("businessId");
    expect(res.body).not.toHaveProperty("reviewNote");

    const sitemap = await request(ctx.app).get("/v1/sitemap").expect(200);
    expect(sitemap.body).toEqual([expect.objectContaining({ citySlug: "bareilly", slug })]);

    const admin = await adminAgent(ctx);
    await admin
      .post(`/v1/admin/businesses/${businessId}/suspend`, { reason: "Complaints" })
      .expect(200);
    await request(ctx.app).get(`/v1/venues/by-slug/bareilly/${slug}`).expect(404);
    const list = await request(ctx.app).get("/v1/cities/bareilly/venues").expect(200);
    expect(list.body.items).toEqual([]);
  });
});
