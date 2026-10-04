import {
  attendanceQuerySchema,
  attendanceUpdateSchema,
  cancelMembershipSchema,
  createBatchSchema,
  idParamsSchema,
  joinMembershipRequestSchema,
  memberListQuerySchema,
  planInputSchema,
  updateBatchSchema,
  type CreateBatch,
  type JoinMembershipRequest,
  type PlanInput,
  type UpdateBatch,
} from "@townplay/shared";
import { Router } from "express";
import type { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import type { MembershipService } from "../services/memberships.js";

/** Membership plans, coaching batches, members and attendance. Ownership is checked in the service. */
export function membershipsRouter(auth: Auth, memberships: MembershipService): Router {
  const router = Router();
  const signedIn = requireAuth(auth);
  const withId = validate({ params: idParamsSchema });

  // ---------- public ----------
  router.get("/venues/:id/offerings", withId, async (req, res) => {
    res.json(await memberships.offerings(param(req, "id")));
  });

  // ---------- player ----------
  router.post(
    "/memberships",
    signedIn,
    validate({ body: joinMembershipRequestSchema }),
    async (req, res) => {
      res.status(201).json(await memberships.join(req.user!, req.body as JoinMembershipRequest));
    },
  );
  router.get("/memberships/mine", signedIn, async (req, res) => {
    res.json(await memberships.listMine(req.user!));
  });
  router.get("/memberships/:id", signedIn, withId, async (req, res) => {
    res.json(await memberships.getMine(req.user!, param(req, "id")));
  });
  router.post("/memberships/:id/renew", signedIn, withId, async (req, res) => {
    res.status(201).json(await memberships.renew(req.user!, param(req, "id")));
  });

  // ---------- owner ----------
  router.get("/owner/venues/:id/plans", signedIn, withId, async (req, res) => {
    res.json(await memberships.listPlans(req.user!, param(req, "id")));
  });
  router.post(
    "/owner/venues/:id/plans",
    signedIn,
    validate({ params: idParamsSchema, body: planInputSchema }),
    async (req, res) => {
      res
        .status(201)
        .json(await memberships.createPlan(req.user!, param(req, "id"), req.body as PlanInput));
    },
  );
  router.put(
    "/owner/plans/:id",
    signedIn,
    validate({ params: idParamsSchema, body: planInputSchema }),
    async (req, res) => {
      res.json(await memberships.updatePlan(req.user!, param(req, "id"), req.body as PlanInput));
    },
  );

  router.get("/owner/venues/:id/batches", signedIn, withId, async (req, res) => {
    res.json(await memberships.listBatches(req.user!, param(req, "id")));
  });
  router.post(
    "/owner/venues/:id/batches",
    signedIn,
    validate({ params: idParamsSchema, body: createBatchSchema }),
    async (req, res) => {
      res
        .status(201)
        .json(await memberships.createBatch(req.user!, param(req, "id"), req.body as CreateBatch));
    },
  );
  router.patch(
    "/owner/batches/:id",
    signedIn,
    validate({ params: idParamsSchema, body: updateBatchSchema }),
    async (req, res) => {
      res.json(await memberships.updateBatch(req.user!, param(req, "id"), req.body as UpdateBatch));
    },
  );
  router.post("/owner/batches/:id/end", signedIn, withId, async (req, res) => {
    res.json(await memberships.endBatch(req.user!, param(req, "id")));
  });
  router.get(
    "/owner/batches/:id/attendance",
    signedIn,
    validate({ params: idParamsSchema, query: attendanceQuerySchema }),
    async (req, res) => {
      const q = res.locals.query as z.infer<typeof attendanceQuerySchema>;
      res.json(await memberships.attendance(req.user!, param(req, "id"), q.date));
    },
  );
  router.put(
    "/owner/batches/:id/attendance",
    signedIn,
    validate({ params: idParamsSchema, body: attendanceUpdateSchema }),
    async (req, res) => {
      res.json(
        await memberships.markAttendance(
          req.user!,
          param(req, "id"),
          req.body as z.infer<typeof attendanceUpdateSchema>,
        ),
      );
    },
  );

  router.get(
    "/owner/venues/:id/members",
    signedIn,
    validate({ params: idParamsSchema, query: memberListQuerySchema }),
    async (req, res) => {
      res.json(
        await memberships.members(
          req.user!,
          param(req, "id"),
          res.locals.query as z.infer<typeof memberListQuerySchema>,
        ),
      );
    },
  );
  router.post(
    "/owner/memberships/:id/cancel",
    signedIn,
    validate({ params: idParamsSchema, body: cancelMembershipSchema }),
    async (req, res) => {
      const body = req.body as z.infer<typeof cancelMembershipSchema>;
      res.json(await memberships.ownerCancel(req.user!, param(req, "id"), body.reason));
    },
  );

  return router;
}
