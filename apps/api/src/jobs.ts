import { MongoBackend } from "@agendajs/mongo-backend";
import { Agenda } from "agenda";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import type { Services } from "./services/index.js";

/** Scheduled jobs (Agenda, Mongo-backed so only one api instance runs each tick). */
export async function startJobs(db: Db, services: Services, logger: Logger): Promise<Agenda> {
  const { bookings, tickets, eventsService, shares, memberships } = services;
  const agenda = new Agenda({
    backend: new MongoBackend({ mongo: db, collection: "agendaJobs" }),
    processEvery: "30 seconds",
  });

  agenda.define("bookings:expire-holds", async () => {
    const n = await bookings.expireHolds();
    if (n) logger.info({ n }, "expired holds");
  });
  agenda.define("bookings:complete-finished", async () => {
    const n = await bookings.completeFinished();
    if (n) logger.info({ n }, "completed bookings");
  });

  agenda.define("tickets:expire-holds", async () => {
    const n = await tickets.expireHolds();
    if (n) logger.info({ n }, "expired ticket holds");
  });
  agenda.define("events:reminders", async () => {
    const n = await tickets.sendReminders();
    if (n) logger.info({ n }, "sent event reminders");
  });
  agenda.define("events:complete-finished", async () => {
    await eventsService.completeFinished();
  });

  agenda.define("shares:expire-holds", async () => {
    const n = await shares.expireHolds();
    if (n) logger.info({ n }, "expired game spot holds");
  });
  agenda.define("games:cutoffs", async () => {
    await shares.cutoffs();
  });

  agenda.define("memberships:expire-holds", async () => {
    const n = await memberships.expireHolds();
    if (n) logger.info({ n }, "expired membership holds");
  });
  agenda.define("memberships:daily", async () => {
    const ended = await memberships.expireEnded();
    const reminded = await memberships.sendReminders();
    const reserved = await memberships.topUpBatchLocks();
    logger.info({ ended, reminded, reserved }, "memberships daily");
  });

  await agenda.start();
  await agenda.every("1 minute", "bookings:expire-holds");
  await agenda.every("10 minutes", "bookings:complete-finished");
  await agenda.every("1 minute", "tickets:expire-holds");
  await agenda.every("1 hour", "events:reminders");
  await agenda.every("1 hour", "events:complete-finished");
  await agenda.every("1 minute", "shares:expire-holds");
  await agenda.every("5 minutes", "games:cutoffs");
  await agenda.every("1 minute", "memberships:expire-holds");
  // Hourly is cheap and catches up quickly after a missed run; each step is idempotent.
  await agenda.every("1 hour", "memberships:daily");
  return agenda;
}
