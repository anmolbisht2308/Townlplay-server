import { updateMeSchema, type Me, type UpdateMe } from "@townplay/shared";
import { Router } from "express";
import { Types } from "mongoose";
import type { Auth } from "../auth/auth.js";
import { notFound } from "../lib/httpError.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserModel } from "../models/user.js";

export function meRouter(auth: Auth): Router {
  const router = Router();
  router.use("/me", requireAuth(auth));

  router.get("/me", (req, res) => {
    res.json(req.user satisfies Me | undefined);
  });

  router.patch("/me", validate({ body: updateMeSchema }), async (req, res) => {
    const me = req.user!;
    const patch = req.body as UpdateMe;
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    const $unset: Record<string, 1> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.lang !== undefined) $set.lang = patch.lang;
    if (patch.phone === null) $unset.phone = 1;
    else if (patch.phone !== undefined) $set.phone = patch.phone;

    const updated = await UserModel.findByIdAndUpdate(
      new Types.ObjectId(me.id),
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { new: true },
    ).lean();
    if (!updated) throw notFound("User");
    const body: Me = {
      ...me,
      name: updated.name,
      lang: updated.lang,
      phone: updated.phone ?? null,
    };
    res.json(body);
  });

  return router;
}
