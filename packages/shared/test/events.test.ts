import { describe, expect, it } from "vitest";
import {
  createEventSchema,
  eventIcs,
  eventWindow,
  ticketOrderRequestSchema,
} from "../src/events.js";

const base = {
  businessId: "a".repeat(24),
  citySlug: "bareilly",
  title: "Diwali Mela",
  type: "seasonal",
  description: "",
  photos: [],
  startsAt: "2026-11-08T12:30:00.000Z",
  endsAt: "2026-11-08T17:30:00.000Z",
  venueId: null,
  address: "Company Garden, Bareilly",
  location: { lat: 28.36, lng: 79.41 },
  ageLimit: null,
  tiers: [{ name: "Entry", pricePaise: 10000, capacity: 500 }],
};

describe("events schemas", () => {
  it("requires a venue or an address with a pin, and end after start", () => {
    expect(createEventSchema.safeParse(base).success).toBe(true);
    expect(createEventSchema.safeParse({ ...base, address: null }).success).toBe(false);
    expect(
      createEventSchema.safeParse({
        ...base,
        address: null,
        location: null,
        venueId: "b".repeat(24),
      }).success,
    ).toBe(true);
    expect(createEventSchema.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
  });

  it("caps tickets per order and rejects repeated tiers", () => {
    const req = { eventId: "a".repeat(24), buyer: { name: "Asha", phone: "9876543210" } };
    expect(
      ticketOrderRequestSchema.safeParse({ ...req, items: [{ tierId: "b".repeat(24), qty: 2 }] })
        .success,
    ).toBe(true);
    expect(
      ticketOrderRequestSchema.safeParse({ ...req, items: [{ tierId: "b".repeat(24), qty: 11 }] })
        .success,
    ).toBe(false);
    expect(
      ticketOrderRequestSchema.safeParse({
        ...req,
        items: [
          { tierId: "b".repeat(24), qty: 1 },
          { tierId: "b".repeat(24), qty: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("eventWindow", () => {
  it("this week runs to Monday 00:00 IST; this weekend is Sat–Sun", () => {
    const wed = new Date("2026-10-07T06:30:00Z"); // Wed 12:00 IST
    expect(eventWindow("this_week", wed).to?.toISOString()).toBe("2026-10-11T18:30:00.000Z");
    const weekend = eventWindow("this_weekend", wed);
    expect(weekend.from.toISOString()).toBe("2026-10-09T18:30:00.000Z");
    expect(weekend.to?.toISOString()).toBe("2026-10-11T18:30:00.000Z");
    const sun = new Date("2026-10-11T06:30:00Z");
    expect(eventWindow("this_weekend", sun).from).toEqual(sun);
    expect(eventWindow("upcoming", wed).to).toBeNull();
  });
});

describe("eventIcs", () => {
  it("builds a valid calendar entry with escaped text", () => {
    const ics = eventIcs(
      {
        id: "x1",
        title: "Mela, Night; Fun",
        startsAt: base.startsAt,
        endsAt: base.endsAt,
        address: "Garden",
        url: "https://t.in/e",
      },
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(ics).toContain("DTSTART:20261108T123000Z");
    expect(ics).toContain(String.raw`SUMMARY:Mela\, Night\; Fun`);
    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
  });
});
