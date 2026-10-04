import {
  availabilityQuerySchema,
  balanceRequestSchema,
  bookingListQuerySchema,
  calendarQuerySchema,
  cancelRequestSchema,
  holdRequestSchema,
  idParamsSchema,
  ownerBookingRequestSchema,
  type HoldRequest,
  type OwnerBookingRequest,
} from "@townplay/shared";
import { Router } from "express";
import type { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import type { BookingService } from "../services/bookings.js";

type DateQuery = z.infer<typeof availabilityQuerySchema>;

export function bookingsRouter(auth: Auth, bookings: BookingService): Router {
  const router = Router();
  const signedIn = requireAuth(auth);
  const withId = validate({ params: idParamsSchema });

  // Public availability.
  router.get(
    "/venues/:id/availability",
    validate({ params: idParamsSchema, query: availabilityQuerySchema }),
    async (req, res) => {
      res.json(
        await bookings.venueAvailability(param(req, "id"), (res.locals.query as DateQuery).date),
      );
    },
  );
  router.get(
    "/resources/:id/availability",
    validate({ params: idParamsSchema, query: availabilityQuerySchema }),
    async (req, res) => {
      res.json(
        await bookings.resourceAvailability(param(req, "id"), (res.locals.query as DateQuery).date),
      );
    },
  );

  // Player.
  router.post(
    "/bookings/hold",
    signedIn,
    validate({ body: holdRequestSchema }),
    async (req, res) => {
      const booking = await bookings.hold(req.user!, req.body as HoldRequest);
      res.status(201).json(await bookings.toDto(booking, "player"));
    },
  );
  router.get(
    "/bookings/mine",
    signedIn,
    validate({ query: bookingListQuerySchema }),
    async (req, res) => {
      const { scope } = res.locals.query as z.infer<typeof bookingListQuerySchema>;
      res.json(await bookings.listMine(req.user!, scope));
    },
  );
  router.get("/bookings/:id", signedIn, withId, async (req, res) => {
    res.json(await bookings.getForViewer(req.user!, param(req, "id")));
  });
  router.post(
    "/bookings/:id/cancel",
    signedIn,
    validate({ params: idParamsSchema, body: cancelRequestSchema }),
    async (req, res) => {
      const { reason } = req.body as z.infer<typeof cancelRequestSchema>;
      const booking = await bookings.cancel(req.user!, param(req, "id"), reason);
      res.json(await bookings.getForViewer(req.user!, String(booking._id)));
    },
  );

  // Owner.
  router.get(
    "/venues/:id/calendar",
    signedIn,
    validate({ params: idParamsSchema, query: calendarQuerySchema }),
    async (req, res) => {
      res.json(
        await bookings.calendar(req.user!, param(req, "id"), (res.locals.query as DateQuery).date),
      );
    },
  );
  router.post(
    "/venues/:id/bookings",
    signedIn,
    validate({ params: idParamsSchema, body: ownerBookingRequestSchema }),
    async (req, res) => {
      const booking = await bookings.ownerCreate(
        req.user!,
        param(req, "id"),
        req.body as OwnerBookingRequest,
      );
      res.status(201).json(await bookings.toDto(booking, "owner"));
    },
  );
  router.post(
    "/bookings/:id/balance",
    signedIn,
    validate({ params: idParamsSchema, body: balanceRequestSchema }),
    async (req, res) => {
      const { method } = req.body as z.infer<typeof balanceRequestSchema>;
      res.json(
        await bookings.toDto(
          await bookings.markBalance(req.user!, param(req, "id"), method),
          "owner",
        ),
      );
    },
  );
  router.post("/bookings/:id/no-show", signedIn, withId, async (req, res) => {
    res.json(
      await bookings.toDto(
        await bookings.markOutcome(req.user!, param(req, "id"), "no_show"),
        "owner",
      ),
    );
  });
  router.post("/bookings/:id/complete", signedIn, withId, async (req, res) => {
    res.json(
      await bookings.toDto(
        await bookings.markOutcome(req.user!, param(req, "id"), "completed"),
        "owner",
      ),
    );
  });

  return router;
}
