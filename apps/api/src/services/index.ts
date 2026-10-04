import type { Logger } from "pino";
import type { Env } from "../env.js";
import { setPayoutsMode } from "../lib/dto.js";
import { BookingEventBus } from "./bookingEvents.js";
import { createBookingService } from "./bookings.js";
import type { EmailSender } from "./email.js";
import { createNotifier } from "./notify.js";
import type { PaymentGateway } from "./paymentGateway.js";
import { createPaymentsService } from "./payments.js";
import { createPayoutService } from "./payouts.js";
import type { PushSender } from "./push.js";
import { createSettingsService } from "./settings.js";
import { createEventService } from "./events.js";
import { createMembershipService } from "./memberships.js";
import { createShareService } from "./shares.js";
import { createTicketService } from "./tickets.js";
import type { CloudinaryConfig } from "./uploads.js";

/** Wires the domain services; server.ts and tests both build the app from this. */
export function createServices(deps: {
  env: Env;
  logger: Logger;
  email: EmailSender;
  push: PushSender;
  gateway: PaymentGateway;
  cloudinary?: CloudinaryConfig;
  now?: () => Date;
}) {
  const { env, logger, email, push, gateway, cloudinary, now } = deps;
  setPayoutsMode(env.PAYOUTS_MODE);
  const events = new BookingEventBus();
  const settings = createSettingsService(env.CONVENIENCE_FEE_CONFIG);
  const notifier = createNotifier({ email, push, logger, webOrigin: env.WEB_ORIGIN });
  const bookings = createBookingService({ events, notifier, settings, ...(now ? { now } : {}) });
  const payouts = createPayoutService({
    gateway,
    mode: env.PAYOUTS_MODE,
    authSecret: env.AUTH_SECRET,
    logger,
  });
  const eventsService = createEventService({ cloudinary, ...(now ? { now } : {}) });
  const tickets = createTicketService({
    settings,
    email,
    logger,
    webOrigin: env.WEB_ORIGIN,
    ...(now ? { now } : {}),
  });
  const shares = createShareService({
    settings,
    email,
    logger,
    webOrigin: env.WEB_ORIGIN,
    ...(now ? { now } : {}),
  });
  const memberships = createMembershipService({
    bookings,
    settings,
    email,
    push,
    logger,
    webOrigin: env.WEB_ORIGIN,
    ...(now ? { now } : {}),
  });
  const payments = createPaymentsService({
    gateway,
    bookings,
    tickets,
    shares,
    memberships,
    payouts,
    notifier,
    logger,
    ...(now ? { now } : {}),
  });
  bookings.setRefunder(payments);
  tickets.setRefunder(payments);
  shares.setRefunder(payments);
  memberships.setRefunder(payments);
  bookings.setOnCancelled(shares.onBookingCancelled);
  return {
    events,
    eventsService,
    tickets,
    shares,
    memberships,
    settings,
    notifier,
    bookings,
    payouts,
    payments,
    gateway,
    push,
  };
}

export type Services = ReturnType<typeof createServices>;
