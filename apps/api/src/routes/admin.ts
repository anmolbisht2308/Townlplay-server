import { idParamsSchema, reviewQueueQuerySchema, reviewReasonSchema } from "@townplay/shared";
import { Router } from "express";
import type { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { toBusiness, toVenue } from "../lib/dto.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import * as review from "../services/review.js";

type Reason = z.infer<typeof reviewReasonSchema>;

export function adminRouter(auth: Auth): Router {
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

  return router;
}
