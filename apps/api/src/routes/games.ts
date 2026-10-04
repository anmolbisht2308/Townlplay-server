import {
  gameListQuerySchema,
  idParamsSchema,
  joinGameRequestSchema,
  openGameRequestSchema,
  shareTokenParamsSchema,
  splitRequestSchema,
  type OpenGameRequest,
  type SplitRequest,
} from "@townplay/shared";
import { Router } from "express";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import type { PaymentsService } from "../services/payments.js";
import type { ShareService } from "../services/shares.js";

const slug = z.string().regex(/^[a-z0-9-]{1,80}$/);

/** Open games (join a booking as a player) and split payments (friends pay their share). */
export function gamesRouter(auth: Auth, shares: ShareService, payments: PaymentsService): Router {
  const router = Router();
  const signedIn = requireAuth(auth);
  const withId = validate({ params: idParamsSchema });

  router.get(
    "/cities/:slug/games",
    validate({ params: z.object({ slug }), query: gameListQuerySchema }),
    async (req, res) => {
      res.json(
        await shares.listGames(
          param(req, "slug"),
          res.locals.query as z.infer<typeof gameListQuerySchema>,
        ),
      );
    },
  );
  router.get("/games/:id", optionalAuth(auth), withId, async (req, res) => {
    res.json(await shares.getGame(req.user, param(req, "id")));
  });
  router.post(
    "/games/:id/join",
    signedIn,
    validate({ params: idParamsSchema, body: joinGameRequestSchema }),
    async (req, res) => {
      await shares.join(
        req.user!,
        param(req, "id"),
        req.body as z.infer<typeof joinGameRequestSchema>,
      );
      res.status(201).json(await shares.getGame(req.user, param(req, "id")));
    },
  );
  router.post("/games/:id/leave", signedIn, withId, async (req, res) => {
    await shares.leave(req.user!, param(req, "id"));
    res.json(await shares.getGame(req.user, param(req, "id")));
  });
  router.post("/games/:id/cancel", signedIn, withId, async (req, res) => {
    await shares.cancelGame(req.user!, param(req, "id"));
    res.json(await shares.getGame(req.user, param(req, "id")));
  });
  router.post("/games/:id/keep", signedIn, withId, async (req, res) => {
    await shares.keepGame(req.user!, param(req, "id"));
    res.json(await shares.getGame(req.user, param(req, "id")));
  });

  router.post(
    "/bookings/:id/open-game",
    signedIn,
    validate({ params: idParamsSchema, body: openGameRequestSchema }),
    async (req, res) => {
      const game = await shares.openGame(req.user!, param(req, "id"), req.body as OpenGameRequest);
      res.status(201).json(await shares.getGame(req.user, String(game._id)));
    },
  );
  router.post(
    "/bookings/:id/split",
    signedIn,
    validate({ params: idParamsSchema, body: splitRequestSchema }),
    async (req, res) => {
      res
        .status(201)
        .json(await shares.createSplit(req.user!, param(req, "id"), req.body as SplitRequest));
    },
  );
  router.get("/bookings/:id/shares", signedIn, withId, async (req, res) => {
    res.json(await shares.sharesOf(req.user!, param(req, "id")));
  });

  router.get("/shares/:token", validate({ params: shareTokenParamsSchema }), async (req, res) => {
    res.json(await shares.sharePage(param(req, "token")));
  });
  router.post(
    "/shares/:token/order",
    signedIn,
    validate({ params: shareTokenParamsSchema }),
    async (req, res) => {
      const page = await shares.sharePage(param(req, "token"));
      res
        .status(201)
        .json(await payments.createOrder(req.user!, { shareId: page.id }, { viaShareToken: true }));
    },
  );

  return router;
}
