import {
  idParamsSchema,
  recordPayoutRequestSchema,
  reviewQueueQuerySchema,
  reviewReasonSchema,
  settingsSchema,
  type Settings,
} from "@townplay/shared";
import { Router } from "express";
import type { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { toBusiness, toVenue } from "../lib/dto.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import type { PayoutService } from "../services/payouts.js";
import { toEvent } from "../services/events.js";
import * as review from "../services/review.js";
import type { TicketService } from "../services/tickets.js";
import type { SettingsService } from "../services/settings.js";

type Reason = z.infer<typeof reviewReasonSchema>;

export function adminRouter(
  auth: Auth,
  settings: SettingsService,
  payouts: PayoutService,
  tickets: TicketService,
): Router {
  const router = Router();
  router.use("/admin", requireAuth(auth), requireRole("admin"));
  const withReason = validate({ params: idParamsSchema, body: reviewReasonSchema });
  const withId = validate({ params: idParamsSchema });

  router.get("/admin/review", validate({ query: reviewQueueQuerySchema }), async (_req, res) => {
    const { kind, status } = res.locals.query as z.infer<typeof reviewQueueQuerySchema>;
    res.json(await review.reviewQueue(kind, status));
  });

  router.post("/admin/businesses/:id/approve", withId, async (req, res) => {
    res.json(toBusiness(await review.approveBusiness(req.user!, param(req, "id"))));
  });
  router.post("/admin/businesses/:id/reject", withReason, async (req, res) => {
    const { reason } = req.body as Reason;
    res.json(toBusiness(await review.rejectBusiness(req.user!, param(req, "id"), reason)));
  });
  router.post("/admin/businesses/:id/suspend", withReason, async (req, res) => {
    const { reason } = req.body as Reason;
    res.json(toBusiness(await review.suspendBusiness(req.user!, param(req, "id"), reason)));
  });

  router.post("/admin/venues/:id/approve", withId, async (req, res) => {
    res.json(toVenue(await review.approveVenue(req.user!, param(req, "id"))));
  });
  router.post("/admin/venues/:id/reject", withReason, async (req, res) => {
    const { reason } = req.body as Reason;
    res.json(toVenue(await review.rejectVenue(req.user!, param(req, "id"), reason)));
  });
  router.post("/admin/venues/:id/hide", withReason, async (req, res) => {
    const { reason } = req.body as Reason;
    res.json(toVenue(await review.hideVenue(req.user!, param(req, "id"), reason)));
  });

  router.post("/admin/events/:id/approve", withId, async (req, res) => {
    res.json(toEvent(await review.approveEvent(req.user!, param(req, "id"))));
  });
  router.post("/admin/events/:id/reject", withReason, async (req, res) => {
    const { reason } = req.body as Reason;
    res.json(toEvent(await review.rejectEvent(req.user!, param(req, "id"), reason)));
  });
  router.post("/admin/events/:id/cancel", withReason, async (req, res) => {
    const { reason } = req.body as Reason;
    res.json(toEvent(await tickets.cancelEvent(req.user!, param(req, "id"), reason)));
  });

  router.get("/admin/settings", async (_req, res) => {
    res.json(await settings.get());
  });
  router.put("/admin/settings", validate({ body: settingsSchema }), async (req, res) => {
    res.json(await settings.update(req.user!.id, req.body as Settings));
  });

  router.get("/admin/payouts", async (_req, res) => {
    res.json(await payouts.adminReport());
  });
  router.post("/admin/payouts", validate({ body: recordPayoutRequestSchema }), async (req, res) => {
    const input = req.body as z.infer<typeof recordPayoutRequestSchema>;
    const payout = await payouts.record(req.user!, input);
    res.status(201).json({ id: String(payout._id), ...input });
  });

  return router;
}
