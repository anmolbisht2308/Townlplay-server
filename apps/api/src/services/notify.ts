import type { Booking } from "@townplay/shared";
import type { Logger } from "pino";
import { BusinessModel } from "../models/business.js";
import { UserModel } from "../models/user.js";
import type { EmailMessage, EmailSender } from "./email.js";
import {
  bookingCancelledEmail,
  bookingConfirmedEmail,
  ownerCancellationEmail,
  ownerNewBookingEmail,
  refundProcessedEmail,
} from "./emailTemplates.js";
import type { PushSender } from "./push.js";

/**
 * Booking notifications: email to the player, email + web push to the business owners.
 * Failures are logged, never thrown — a booking must not fail because an email bounced.
 */
export function createNotifier(deps: {
  email: EmailSender;
  push: PushSender;
  logger: Logger;
  webOrigin: string;
}) {
  const { email, push, logger, webOrigin } = deps;

  async function safe(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, what }, "notification failed");
    }
  }

  async function playerEmail(userId: string | null, build: (to: string) => EmailMessage) {
    if (!userId) return;
    const user = await UserModel.findById(userId, { email: 1 }).lean();
    if (user?.email) await email.send(build(user.email));
  }

  async function owners(businessId: string) {
    const business = await BusinessModel.findById(businessId, { email: 1, ownerUserIds: 1 }).lean();
    return { email: business?.email, userIds: (business?.ownerUserIds ?? []).map(String) };
  }

  return {
    bookingConfirmed: (b: Booking, ctx: { userId: string | null; businessId: string }) =>
      safe("bookingConfirmed", async () => {
        await playerEmail(ctx.userId, (to) => bookingConfirmedEmail(to, b, webOrigin));
        if (b.source !== "online") return;
        const o = await owners(ctx.businessId);
        if (o.email) await email.send(ownerNewBookingEmail(o.email, b, webOrigin));
        await push.send(o.userIds, {
          title: `New booking · ${b.resource.name}`,
          body: `${b.date} ${b.startTime}–${b.endTime}${b.customer ? ` · ${b.customer.name}` : ""}`,
          url: `/owner/venues/${b.venue.id}/calendar`,
        });
      }),

    bookingCancelled: (b: Booking, ctx: { userId: string | null; businessId: string }) =>
      safe("bookingCancelled", async () => {
        await playerEmail(ctx.userId, (to) => bookingCancelledEmail(to, b, webOrigin));
        if (b.source !== "online" || b.cancellation?.by === "owner") return;
        const o = await owners(ctx.businessId);
        if (o.email) await email.send(ownerCancellationEmail(o.email, b, webOrigin));
        await push.send(o.userIds, {
          title: `Cancelled · ${b.resource.name}`,
          body: `${b.date} ${b.startTime}–${b.endTime} is free again`,
          url: `/owner/venues/${b.venue.id}/calendar`,
        });
      }),

    refundProcessed: (b: Booking, amountPaise: number, ctx: { userId: string | null }) =>
      safe("refundProcessed", () =>
        playerEmail(ctx.userId, (to) => refundProcessedEmail(to, b, amountPaise, webOrigin)),
      ),
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
