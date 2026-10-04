import { pushSubscriptionSchema, type PushSubscriptionInput } from "@townplay/shared";
import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { HttpError } from "../lib/httpError.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { PushSubscriptionModel } from "../models/pushSubscription.js";

const unsubscribeSchema = z.object({ endpoint: z.string().max(2000) }).strict();

/** Web push subscriptions (owners get new-booking / cancellation pushes). */
export function pushRouter(auth: Auth, vapidPublicKey: string | undefined): Router {
  const router = Router();
  const signedIn = requireAuth(auth);

  router.get("/push/public-key", (_req, res) => {
    if (!vapidPublicKey)
      throw new HttpError(503, "PUSH_DISABLED", "Push notifications are not configured");
    res.json({ publicKey: vapidPublicKey });
  });

  router.post(
    "/push/subscriptions",
    signedIn,
    validate({ body: pushSubscriptionSchema }),
    async (req, res) => {
      const sub = req.body as PushSubscriptionInput;
      await PushSubscriptionModel.updateOne(
        { endpoint: sub.endpoint },
        { $set: { userId: new Types.ObjectId(req.user!.id), keys: sub.keys } },
        { upsert: true },
      );
      res.status(204).end();
    },
  );

  router.delete(
    "/push/subscriptions",
    signedIn,
    validate({ body: unsubscribeSchema }),
    async (req, res) => {
      const { endpoint } = req.body as z.infer<typeof unsubscribeSchema>;
      await PushSubscriptionModel.deleteOne({ endpoint, userId: new Types.ObjectId(req.user!.id) });
      res.status(204).end();
    },
  );

  return router;
}
