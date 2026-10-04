import request from "supertest";
import { describe, expect, it } from "vitest";
import { BookingModel } from "../src/models/booking.js";
import { BookingShareModel } from "../src/models/bookingShare.js";
import { EventModel } from "../src/models/event.js";
import { MembershipModel } from "../src/models/membership.js";
import { TicketModel } from "../src/models/ticket.js";
import { UserModel } from "../src/models/user.js";
import { VenueModel } from "../src/models/venue.js";
import { demoEmail, removeDemoData, seedDemo } from "../src/scripts/seedDemo.js";
import { setupApp, WEB_ORIGIN } from "./helpers.js";

describe("demo seed", () => {
  const ctx = setupApp();

  it("creates live venues, paid bookings, an open game, a split, events and members", async () => {
    const summary = await seedDemo(ctx.services, { webOrigin: WEB_ORIGIN });
    expect(summary.accounts.map((a) => a.email)).toContain("owner@townplay.test");
    expect(await VenueModel.countDocuments({ status: "live", businessActive: true })).toBe(3);
    expect(await BookingModel.countDocuments({ source: "online", status: "confirmed" })).toBe(6);
    expect(
      await BookingModel.countDocuments({ source: { $in: ["walkin", "phone", "block"] } }),
    ).toBe(4);
    expect(await BookingModel.countDocuments({ source: "batch" })).toBeGreaterThan(5);
    expect(await BookingModel.countDocuments({ memberDiscountPaise: { $gt: 0 } })).toBe(1);
    expect(await BookingShareModel.countDocuments({ status: "paid" })).toBe(3);
    expect(await EventModel.countDocuments({ status: "published" })).toBe(3);
    expect(await TicketModel.countDocuments()).toBe(4);
    expect(await MembershipModel.countDocuments({ status: "active" })).toBe(3);

    const list = await request(ctx.app).get("/v1/cities/bareilly/venues").expect(200);
    expect(list.body.items).toHaveLength(3);
    const games = await request(ctx.app).get("/v1/cities/bareilly/games").expect(200);
    expect(games.body).toEqual([expect.objectContaining({ spotsLeft: 2 })]);

    await expect(seedDemo(ctx.services, { webOrigin: WEB_ORIGIN })).rejects.toThrow(/--reset/);
    await removeDemoData(undefined);
    expect(await VenueModel.countDocuments()).toBe(0);
    expect(await UserModel.countDocuments({ email: /@townplay\.test$/ })).toBe(0);
    await seedDemo(ctx.services, { webOrigin: WEB_ORIGIN });
    expect(await VenueModel.countDocuments()).toBe(3);
  });

  it("gives demo accounts plus-addresses of DEMO_EMAIL", () => {
    expect(demoEmail("owner", "Me@Gmail.com")).toBe("me+owner@gmail.com");
    expect(demoEmail("asha", undefined)).toBe("asha@townplay.test");
  });
});
