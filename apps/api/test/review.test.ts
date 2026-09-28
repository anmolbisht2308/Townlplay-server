import { beforeEach, describe, expect, it } from "vitest";
import { seed } from "../src/scripts/seed.js";
import { adminAgent, agent, ownerWithVenue } from "./factories.js";
import { setupApp } from "./helpers.js";

describe("admin review", () => {
  const ctx = setupApp();
  beforeEach(() => seed(undefined));

  it("is admin-only", async () => {
    const player = await agent(ctx, "player@example.com");
    const res = await player.get("/v1/admin/review").expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("queues submitted venues; approve activates venue and business", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId, businessId } = await ownerWithVenue(owner);
    await owner.post(`/v1/venues/${venueId}/submit`).expect(200);

    const admin = await adminAgent(ctx);
    const queue = await admin.get("/v1/admin/review?kind=venue").expect(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ id: venueId, businessName: "Green Arena" });
    const businesses = await admin.get("/v1/admin/review?kind=business").expect(200);
    expect(businesses.body[0].id).toBe(businessId);
    await admin.get("/v1/admin/review?kind=venue&status=nonsense").expect(400);

    const approved = await admin.post(`/v1/admin/venues/${venueId}/approve`).expect(200);
    expect(approved.body.status).toBe("live");
    const mine = await owner.get("/v1/businesses/mine").expect(200);
    expect(mine.body[0].status).toBe("active");
    await admin.post(`/v1/admin/venues/${venueId}/approve`).expect(409);
  });

  it("rejects with a reason, and the owner can resubmit", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await ownerWithVenue(owner);
    await owner.post(`/v1/venues/${venueId}/submit`).expect(200);
    const admin = await adminAgent(ctx);
    await admin.post(`/v1/admin/venues/${venueId}/reject`, {}).expect(400);
    const rejected = await admin
      .post(`/v1/admin/venues/${venueId}/reject`, { reason: "Add real photos" })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: "draft", reviewNote: "Add real photos" });
    const resubmitted = await owner.post(`/v1/venues/${venueId}/submit`).expect(200);
    expect(resubmitted.body).toMatchObject({ status: "pending_review", reviewNote: null });
  });

  it("suspending a business blocks approving its venues", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId, businessId } = await ownerWithVenue(owner);
    await owner.post(`/v1/venues/${venueId}/submit`).expect(200);
    const admin = await adminAgent(ctx);
    await admin
      .post(`/v1/admin/businesses/${businessId}/suspend`, { reason: "Fake listing" })
      .expect(200);
    await admin.post(`/v1/admin/venues/${venueId}/approve`).expect(409);
  });
});
