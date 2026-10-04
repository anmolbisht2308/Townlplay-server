/**
 * Demo data for trying the app locally: owners, players, live venues with courts, paid and
 * walk-in bookings, an open game, a split payment, events with tickets, a membership plan and a
 * coaching batch with members. Everything goes through the real services (slot locks, payments
 * in test mode, seats), so the data behaves exactly like data created in the app.
 *
 *   pnpm --filter @townplay/api seed:demo            # adds the demo data (refuses if present)
 *   pnpm --filter @townplay/api seed:demo -- --reset # removes the demo data, then adds it again
 *
 * Accounts sign in with email OTP. Set DEMO_EMAIL=you@gmail.com to give every demo account a
 * plus-address of your inbox (you+owner@gmail.com …) so codes arrive when Brevo is configured;
 * without it they are @townplay.test and the codes are only printed in the api log (no Brevo).
 */
import {
  addDays,
  bookableDates,
  istDate,
  istToUtc,
  rupeesToPaise,
  type CreateEvent,
  type CreateResource,
  type CreateVenue,
} from "@townplay/shared";
import mongoose from "mongoose";
import { pino, type Logger } from "pino";
import { connectMongo } from "../db.js";
import { parseEnv, type Env } from "../env.js";
import type { AuthUser } from "../middleware/auth.js";
import { AttendanceModel } from "../models/attendance.js";
import { BookingModel } from "../models/booking.js";
import { BookingShareModel } from "../models/bookingShare.js";
import { BusinessModel } from "../models/business.js";
import { CoachingBatchModel } from "../models/coachingBatch.js";
import { EventModel } from "../models/event.js";
import { MembershipModel } from "../models/membership.js";
import { MembershipPlanModel } from "../models/membershipPlan.js";
import { OpenGameModel } from "../models/openGame.js";
import { PaymentModel } from "../models/payment.js";
import { ResourceModel } from "../models/resource.js";
import { SlotLockModel } from "../models/slotLock.js";
import { TicketModel } from "../models/ticket.js";
import { TicketOrderModel } from "../models/ticketOrder.js";
import { UserModel } from "../models/user.js";
import { VenueModel } from "../models/venue.js";
import type { EmailMessage, EmailSender } from "../services/email.js";
import { createServices, type Services } from "../services/index.js";
import * as listings from "../services/listings.js";
import { FakeGateway } from "../services/paymentGateway.js";
import { RecordingPushSender } from "../services/push.js";
import * as review from "../services/review.js";
import { seed } from "./seed.js";

const DEMO_BUSINESSES = ["Green Arena Sports", "Smash Point Badminton", "Brew & Board Cafe"];

type Role = "player" | "owner" | "admin";
const PEOPLE: { key: string; name: string; phone: string; roles: Role[] }[] = [
  { key: "admin", name: "Demo Admin", phone: "9000000001", roles: ["player", "admin"] },
  { key: "owner", name: "Rahul Sharma", phone: "9000000002", roles: ["player", "owner"] },
  { key: "owner2", name: "Priya Verma", phone: "9000000003", roles: ["player", "owner"] },
  { key: "asha", name: "Asha Gupta", phone: "9000000011", roles: ["player"] },
  { key: "amit", name: "Amit Singh", phone: "9000000012", roles: ["player"] },
  { key: "neha", name: "Neha Saxena", phone: "9000000013", roles: ["player"] },
  { key: "vikas", name: "Vikas Yadav", phone: "9000000014", roles: ["player"] },
];

/** you@gmail.com → you+owner@gmail.com; without a base: owner@townplay.test. */
export function demoEmail(key: string, base: string | undefined): string {
  if (!base) return `${key}@townplay.test`;
  const [local, domain] = base.toLowerCase().split("@");
  return `${local}+${key}@${domain}`;
}

const allDays = (open: string, close: string) =>
  Array.from({ length: 7 }, () => ({ open, close, closed: false }));

/** Emails are not sent while seeding (no OTPs or confirmations land in real inboxes). */
class SilentEmailSender implements EmailSender {
  readonly name = "silent";
  send(_message: EmailMessage): Promise<void> {
    return Promise.resolve();
  }
}

export interface DemoSummary {
  accounts: { name: string; email: string; roles: string[] }[];
  venues: { name: string; url: string; courts: string[] }[];
  bookings: number;
  openGame: string;
  events: string[];
  plan: string;
  batch: string;
}

export async function removeDemoData(emailBase: string | undefined): Promise<void> {
  const businesses = await BusinessModel.find(
    { name: { $in: DEMO_BUSINESSES } },
    { _id: 1 },
  ).lean();
  const businessIds = businesses.map((b) => b._id);
  const venues = await VenueModel.find({ businessId: { $in: businessIds } }, { _id: 1 }).lean();
  const venueIds = venues.map((v) => v._id);
  const resources = await ResourceModel.find({ venueId: { $in: venueIds } }, { _id: 1 }).lean();
  const bookings = await BookingModel.find({ venueId: { $in: venueIds } }, { _id: 1 }).lean();
  const events = await EventModel.find({ businessId: { $in: businessIds } }, { _id: 1 }).lean();
  const batches = await CoachingBatchModel.find({ venueId: { $in: venueIds } }, { _id: 1 }).lean();
  await Promise.all([
    SlotLockModel.deleteMany({ resourceId: { $in: resources.map((r) => r._id) } }),
    BookingShareModel.deleteMany({ bookingId: { $in: bookings.map((b) => b._id) } }),
    OpenGameModel.deleteMany({ venueId: { $in: venueIds } }),
    BookingModel.deleteMany({ venueId: { $in: venueIds } }),
    TicketModel.deleteMany({ eventId: { $in: events.map((e) => e._id) } }),
    TicketOrderModel.deleteMany({ eventId: { $in: events.map((e) => e._id) } }),
    EventModel.deleteMany({ businessId: { $in: businessIds } }),
    AttendanceModel.deleteMany({ batchId: { $in: batches.map((b) => b._id) } }),
    MembershipModel.deleteMany({ venueId: { $in: venueIds } }),
    MembershipPlanModel.deleteMany({ venueId: { $in: venueIds } }),
    CoachingBatchModel.deleteMany({ venueId: { $in: venueIds } }),
    PaymentModel.deleteMany({ businessId: { $in: businessIds } }),
    ResourceModel.deleteMany({ venueId: { $in: venueIds } }),
    VenueModel.deleteMany({ _id: { $in: venueIds } }),
    BusinessModel.deleteMany({ _id: { $in: businessIds } }),
  ]);
  await UserModel.deleteMany({ email: { $in: PEOPLE.map((p) => demoEmail(p.key, emailBase)) } });
}

export async function seedDemo(
  services: Services,
  opts: { emailBase?: string; webOrigin: string },
): Promise<DemoSummary> {
  if (await BusinessModel.exists({ name: { $in: DEMO_BUSINESSES } })) {
    throw new Error("Demo data already exists. Run with --reset to recreate it.");
  }
  await seed(undefined); // cities
  const { bookings, payments, shares, eventsService, tickets, memberships } = services;

  // ---------- people ----------
  const users: Record<string, AuthUser> = {};
  for (const p of PEOPLE) {
    const email = demoEmail(p.key, opts.emailBase);
    const doc = await UserModel.findOneAndUpdate(
      { email },
      {
        $set: { name: p.name, phone: p.phone, emailVerified: true, updatedAt: new Date() },
        $addToSet: { roles: { $each: p.roles } },
        $setOnInsert: { email, lang: "en", createdAt: new Date() },
      },
      { upsert: true, new: true },
    ).lean();
    users[p.key] = {
      id: String(doc._id),
      name: p.name,
      email,
      image: null,
      phone: p.phone,
      roles: p.roles,
      lang: "en",
      cityId: null,
    };
  }
  const u = (key: string) => users[key]!;
  const customer = (key: string) => ({ name: u(key).name, phone: u(key).phone! });

  async function pay(
    user: AuthUser,
    req: Parameters<typeof payments.createOrder>[1],
    viaToken = false,
  ) {
    const order = await payments.createOrder(user, req, { viaShareToken: viaToken });
    if (!order.result) await payments.fakePay(user, order.orderId, "success");
  }

  // ---------- businesses, venues, courts ----------
  const policy = { advancePercent: 30, cancellationCutoffHours: 6, refundPercentBeforeCutoff: 100 };
  const location = (lat: number, lng: number) => ({ lat, lng });

  async function venue(
    owner: AuthUser,
    businessId: string,
    input: Omit<CreateVenue, "businessId" | "citySlug" | "photos">,
    courts: CreateResource[],
  ) {
    const v = await listings.createVenue(
      owner,
      { ...input, businessId, citySlug: "bareilly", photos: [] },
      undefined,
    );
    const ids: string[] = [];
    for (const c of courts)
      ids.push(String((await listings.createResource(owner, String(v._id), c))._id));
    await listings.submitVenue(owner, String(v._id));
    await review.approveVenue(u("admin"), String(v._id));
    return {
      id: String(v._id),
      slug: v.slug,
      name: v.name,
      courtIds: ids,
      courts: courts.map((c) => c.name),
    };
  }

  const greenArena = await listings.createBusiness(u("owner"), {
    name: "Green Arena Sports",
    type: "sports",
    contactPhone: u("owner").phone!,
    email: u("owner").email,
    kyc: { legalName: "Green Arena Sports LLP" },
  });
  const smash = await listings.createBusiness(u("owner"), {
    name: "Smash Point Badminton",
    type: "sports",
    contactPhone: u("owner").phone!,
    email: u("owner").email,
    kyc: { legalName: "Smash Point Sports" },
  });
  const brew = await listings.createBusiness(u("owner2"), {
    name: "Brew & Board Cafe",
    type: "cafe",
    contactPhone: u("owner2").phone!,
    email: u("owner2").email,
    kyc: { legalName: "Brew and Board Hospitality" },
  });

  const turf = await venue(
    u("owner"),
    String(greenArena._id),
    {
      name: "Green Arena Turf",
      category: "sports",
      sports: ["football", "box_cricket"],
      amenities: ["parking", "floodlights", "drinking_water", "washroom", "changing_room"],
      description:
        "Two FIFA-size 5-a-side turfs near Civil Lines with floodlights for night games.",
      address: "12 Civil Lines, near Company Garden, Bareilly",
      area: "Civil Lines",
      location: location(28.367, 79.4304),
      openingHours: allDays("06:00", "23:00"),
      bookingPolicy: policy,
    },
    [
      {
        name: "Turf A",
        sport: "football",
        slotDurationMins: 60,
        maxPlayers: 14,
        isActive: true,
        pricingRules: [
          {
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "06:00",
            end: "17:00",
            pricePaise: rupeesToPaise(800),
          },
          {
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "17:00",
            end: "23:00",
            pricePaise: rupeesToPaise(1200),
          },
        ],
      },
      {
        name: "Box Cricket Arena",
        sport: "box_cricket",
        slotDurationMins: 60,
        maxPlayers: 16,
        isActive: true,
        pricingRules: [
          {
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "06:00",
            end: "23:00",
            pricePaise: rupeesToPaise(1000),
          },
        ],
      },
    ],
  );
  const court = await venue(
    u("owner"),
    String(smash._id),
    {
      name: "Smash Point Badminton Hall",
      category: "sports",
      sports: ["badminton"],
      amenities: ["parking", "drinking_water", "washroom", "equipment_rental"],
      description: "Indoor wooden courts with BWF-approved mats. Rackets on rent.",
      address: "45 Rajendra Nagar Main Road, Bareilly",
      area: "Rajendra Nagar",
      location: location(28.3489, 79.4183),
      openingHours: allDays("05:00", "22:00"),
      bookingPolicy: {
        advancePercent: 50,
        cancellationCutoffHours: 4,
        refundPercentBeforeCutoff: 100,
      },
    },
    ["Court 1", "Court 2"].map((name): CreateResource => ({
      name,
      sport: "badminton",
      slotDurationMins: 60,
      maxPlayers: 4,
      isActive: true,
      pricingRules: [
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "05:00",
          end: "17:00",
          pricePaise: rupeesToPaise(400),
        },
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "17:00",
          end: "22:00",
          pricePaise: rupeesToPaise(500),
        },
      ],
    })),
  );
  const cafe = await venue(
    u("owner2"),
    String(brew._id),
    {
      name: "Brew & Board Cafe",
      category: "cafe",
      sports: ["snooker"],
      amenities: ["wifi", "cafe", "seating"],
      description: "Board games, snooker and coffee. Open mic every Friday.",
      address: "8 DD Puram, Bareilly",
      area: "DD Puram",
      location: location(28.3721, 79.4251),
      openingHours: allDays("11:00", "23:00"),
      bookingPolicy: {
        advancePercent: 0,
        cancellationCutoffHours: 2,
        refundPercentBeforeCutoff: 100,
      },
    },
    [
      {
        name: "Snooker Table",
        sport: "snooker",
        slotDurationMins: 60,
        maxPlayers: 4,
        isActive: true,
        pricingRules: [
          {
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "11:00",
            end: "23:00",
            pricePaise: rupeesToPaise(300),
          },
        ],
      },
    ],
  );

  // ---------- coaching batch first: it reserves Turf A 18:00–19:00 on Mon/Wed/Fri ----------
  const batch = await memberships.createBatch(u("owner"), turf.id, {
    title: "Evening Football Academy",
    activity: "Football",
    coachName: "Coach Ravi Kumar",
    description: "Ages 10–16. Drills, small-sided games and fitness.",
    capacity: 15,
    monthlyFeePaise: rupeesToPaise(1500),
    resourceId: turf.courtIds[0]!,
    days: [1, 3, 5],
    startTime: "18:00",
    endTime: "19:00",
    startDate: istDate(),
  });
  const plan = await memberships.createPlan(u("owner"), turf.id, {
    name: "Monthly Turf Member",
    description: "10% off your bookings, up to 8 a month.",
    durationMonths: 1,
    pricePaise: rupeesToPaise(999),
    discountPercent: 10,
    bookingsPerMonth: 8,
    isActive: true,
  });
  await memberships.createPlan(u("owner"), court.id, {
    name: "Quarterly Shuttler",
    description: "15% off every court booking for 3 months.",
    durationMonths: 3,
    pricePaise: rupeesToPaise(2499),
    discountPercent: 15,
    bookingsPerMonth: null,
    isActive: true,
  });
  for (const key of ["asha", "vikas"]) {
    const m = await memberships.join(u(key), { batchId: batch.id, member: customer(key) });
    await pay(u(key), { membershipId: m.id });
  }
  {
    const m = await memberships.join(u("neha"), { planId: plan.id, member: customer("neha") });
    await pay(u("neha"), { membershipId: m.id });
  }

  // ---------- bookings ----------
  const days = bookableDates();
  const day = (i: number) => days[i]!;
  let bookingCount = 0;
  async function online(key: string, resourceId: string, date: string, startTimes: string[]) {
    const hold = await bookings.hold(u(key), {
      resourceId,
      date,
      startTimes,
      customer: customer(key),
    });
    await pay(u(key), { bookingId: String(hold._id) });
    bookingCount++;
    return String(hold._id);
  }
  async function walkin(
    owner: AuthUser,
    venueId: string,
    resourceId: string,
    date: string,
    startTimes: string[],
    who: { name: string; phone: string } | null,
    source: "walkin" | "phone" | "block",
    note?: string,
  ) {
    await bookings.ownerCreate(owner, venueId, {
      resourceId,
      date,
      startTimes,
      source,
      ...(who ? { customer: who } : {}),
      ...(note ? { note } : {}),
    });
    bookingCount++;
  }

  const [turfA, boxCricket] = turf.courtIds as [string, string];
  const [court1, court2] = court.courtIds as [string, string];
  const gameBooking = await online("amit", turfA, day(2), ["20:00", "21:00"]);
  const splitBooking = await online("asha", boxCricket, day(3), ["19:00", "20:00"]);
  await online("neha", turfA, day(1), ["07:00"]); // member discount applies
  await online("vikas", court1, day(1), ["06:00"]);
  await online("asha", court2, day(2), ["18:00"]);
  await online("amit", cafe.courtIds[0]!, day(1), ["16:00", "17:00"]);
  await walkin(
    u("owner"),
    turf.id,
    turfA,
    day(1),
    ["10:00"],
    { name: "Rohit Mishra", phone: "9123400001" },
    "walkin",
  );
  await walkin(
    u("owner"),
    turf.id,
    boxCricket,
    day(2),
    ["17:00"],
    { name: "Sameer Khan", phone: "9123400002" },
    "phone",
  );
  await walkin(
    u("owner"),
    turf.id,
    turfA,
    day(4),
    ["12:00", "13:00"],
    null,
    "block",
    "Turf maintenance",
  );
  await walkin(
    u("owner"),
    court.id,
    court1,
    day(3),
    ["19:00"],
    { name: "Kavya Jain", phone: "9123400003" },
    "walkin",
  );

  // Open game: Amit's turf booking needs 4 more players; two have joined and paid.
  const game = await shares.openGame(u("amit"), gameBooking, {
    skillLevel: "intermediate",
    spotsNeeded: 4,
    pricePerHeadPaise: rupeesToPaise(150),
    note: "Friendly 7-a-side, bring dark and light T-shirts.",
  });
  for (const key of ["vikas", "neha"]) {
    const share = await shares.join(u(key), String(game._id), customer(key));
    await pay(u(key), { shareId: String(share._id) });
  }

  // Split payment: Asha splits her box cricket balance with two friends; Amit has paid his.
  const split = await shares.createSplit(u("asha"), splitBooking, {
    shares: [{ name: "Amit Singh", phone: u("amit").phone! }, { name: "Rakesh" }],
  });
  await pay(u("amit"), { shareId: split.shares[0]!.id }, true);

  // ---------- events ----------
  const at = (dayOffset: number, time: string) =>
    istToUtc(addDays(istDate(), dayOffset), time).toISOString();
  async function event(
    owner: AuthUser,
    input: Omit<CreateEvent, "citySlug" | "photos" | "ageLimit">,
  ) {
    const e = await eventsService.create(owner, {
      ...input,
      citySlug: "bareilly",
      photos: [],
      ageLimit: null,
    });
    await eventsService.submit(owner, String(e._id));
    await review.approveEvent(u("admin"), String(e._id));
    return e;
  }
  const mela = await event(u("owner2"), {
    businessId: String(brew._id),
    title: "Bareilly Diwali Mela",
    type: "seasonal",
    description: "Food stalls, live music, rangoli and a fireworks show.",
    startsAt: at(6, "16:00"),
    endsAt: at(6, "22:00"),
    venueId: null,
    address: "Company Garden, Civil Lines, Bareilly",
    location: location(28.3637, 79.4203),
    tiers: [
      { name: "Entry", pricePaise: rupeesToPaise(200), capacity: 500 },
      { name: "Family pass (4)", pricePaise: rupeesToPaise(600), capacity: 100 },
    ],
  });
  const openMic = await event(u("owner2"), {
    businessId: String(brew._id),
    title: "Friday Open Mic Night",
    type: "cafe",
    description: "Poetry, stand-up and acoustic sets. Sign up at the counter.",
    startsAt: at(4, "19:00"),
    endsAt: at(4, "22:00"),
    venueId: cafe.id,
    address: null,
    location: null,
    tiers: [
      { name: "Free entry", pricePaise: 0, capacity: 60 },
      { name: "Entry + coffee", pricePaise: rupeesToPaise(150), capacity: 40 },
    ],
  });
  await event(u("owner"), {
    businessId: String(greenArena._id),
    title: "Sunday 5K Run Club",
    type: "club_session",
    description: "Easy-paced 5K around Civil Lines, then stretching on the turf.",
    startsAt: at(5, "06:00"),
    endsAt: at(5, "07:30"),
    venueId: turf.id,
    address: null,
    location: null,
    tiers: [{ name: "Runner", pricePaise: 0, capacity: 80 }],
  });
  for (const [key, tierIndex, qty] of [
    ["asha", 0, 2],
    ["amit", 1, 1],
  ] as const) {
    const order = await tickets.reserve(u(key), {
      eventId: String(mela._id),
      items: [{ tierId: String(mela.tiers[tierIndex]!._id), qty }],
      buyer: customer(key),
    });
    await pay(u(key), { ticketOrderId: String(order._id) });
  }
  await tickets.reserve(u("neha"), {
    eventId: String(openMic._id),
    items: [{ tierId: String(openMic.tiers[0]!._id), qty: 1 }],
    buyer: customer("neha"),
  }); // free tier: confirmed at once

  return {
    accounts: PEOPLE.map((p) => ({ name: p.name, email: u(p.key).email, roles: p.roles })),
    venues: [turf, court, cafe].map((v) => ({
      name: v.name,
      url: `${opts.webOrigin}/bareilly/venues/${v.slug}`,
      courts: v.courts,
    })),
    bookings: bookingCount,
    openGame: `${opts.webOrigin}/games/${String(game._id)}`,
    events: ["Bareilly Diwali Mela", "Friday Open Mic Night", "Sunday 5K Run Club"],
    plan: plan.name,
    batch: batch.title,
  };
}

export function demoServices(env: Env, logger: Logger): Services {
  return createServices({
    env: { ...env, PAYOUTS_MODE: "manual" },
    logger,
    email: new SilentEmailSender(),
    push: new RecordingPushSender(),
    gateway: new FakeGateway(),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = parseEnv(process.env);
  const logger = pino({ level: "warn" });
  const emailBase = process.env.DEMO_EMAIL || undefined;
  await connectMongo(env.MONGODB_URI);
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  if (process.argv.includes("--reset")) await removeDemoData(emailBase);
  const summary = await seedDemo(demoServices(env, logger), {
    emailBase,
    webOrigin: env.WEB_ORIGIN,
  });
  const lines = [
    "",
    "Demo data added.",
    "",
    "Accounts (sign in with email; the code is emailed via Brevo or printed in the api log):",
    ...summary.accounts.map(
      (a) => `  ${a.name.padEnd(14)} ${a.email.padEnd(34)} ${a.roles.join(", ")}`,
    ),
    "",
    "Venues:",
    ...summary.venues.map((v) => `  ${v.name} (${v.courts.join(", ")})  ${v.url}`),
    "",
    `Bookings: ${summary.bookings}  ·  Open game: ${summary.openGame}`,
    `Events: ${summary.events.join(", ")}`,
    `Membership plan: ${summary.plan}  ·  Batch: ${summary.batch}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
  await mongoose.disconnect();
}
