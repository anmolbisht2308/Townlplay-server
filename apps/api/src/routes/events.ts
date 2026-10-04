import {
  attendeeQuerySchema,
  checkInRequestSchema,
  createEventSchema,
  eventListQuerySchema,
  idParamsSchema,
  objectIdSchema,
  reviewReasonSchema,
  ticketOrderRequestSchema,
  updateEventSchema,
  type CreateEvent,
  type EventListQuery,
  type TicketOrderRequest,
  type UpdateEvent,
} from "@townplay/shared";
import { Router } from "express";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { param, validate } from "../middleware/validate.js";
import { loadOwnedEvent, toEvent, type EventService } from "../services/events.js";
import type { TicketService } from "../services/tickets.js";

const slug = z.string().regex(/^[a-z0-9-]{1,100}$/);

export function eventsRouter(auth: Auth, events: EventService, tickets: TicketService): Router {
  const router = Router();
  const signedIn = requireAuth(auth);
  const withId = validate({ params: idParamsSchema });

  // ---------- public ----------
  router.get(
    "/cities/:slug/events",
    validate({ params: z.object({ slug }), query: eventListQuerySchema }),
    async (req, res) => {
      res.json(await events.list(param(req, "slug"), res.locals.query as EventListQuery));
    },
  );
  router.get(
    "/events/by-slug/:city/:slug",
    validate({ params: z.object({ city: slug, slug }) }),
    async (req, res) => {
      res.json(await events.bySlug(param(req, "city"), param(req, "slug")));
    },
  );
  router.get("/sitemap/events", async (_req, res) => {
    res.json(await events.sitemap());
  });

  // ---------- organiser ----------
  router.get("/events/mine", signedIn, async (req, res) => {
    const mine = await events.listMine(req.user!);
    const names = await events.venueNames(mine.map((e) => e.toObject()));
    res.json(
      mine.map((e) => toEvent(e, e.venueId ? (names.get(String(e.venueId)) ?? null) : null)),
    );
  });
  router.post("/events", signedIn, validate({ body: createEventSchema }), async (req, res) => {
    res.status(201).json(toEvent(await events.create(req.user!, req.body as CreateEvent)));
  });
  router.get("/events/:id", signedIn, withId, async (req, res) => {
    res.json(toEvent(await loadOwnedEvent(req.user!, param(req, "id"))));
  });
  router.patch(
    "/events/:id",
    signedIn,
    validate({ params: idParamsSchema, body: updateEventSchema }),
    async (req, res) => {
      res.json(toEvent(await events.update(req.user!, param(req, "id"), req.body as UpdateEvent)));
    },
  );
  router.post("/events/:id/submit", signedIn, withId, async (req, res) => {
    res.json(toEvent(await events.submit(req.user!, param(req, "id"))));
  });
  router.post(
    "/events/:id/cancel",
    signedIn,
    validate({ params: idParamsSchema, body: reviewReasonSchema }),
    async (req, res) => {
      const { reason } = req.body as z.infer<typeof reviewReasonSchema>;
      res.json(toEvent(await tickets.cancelEvent(req.user!, param(req, "id"), reason)));
    },
  );
  router.get("/events/:id/dashboard", signedIn, withId, async (req, res) => {
    res.json(await tickets.dashboard(req.user!, param(req, "id")));
  });
  router.get(
    "/events/:id/attendees",
    signedIn,
    validate({ params: idParamsSchema, query: attendeeQuerySchema }),
    async (req, res) => {
      const { q } = res.locals.query as z.infer<typeof attendeeQuerySchema>;
      res.json(await tickets.attendees(req.user!, param(req, "id"), q));
    },
  );
  router.get("/events/:id/attendees.csv", signedIn, withId, async (req, res) => {
    const csv = await tickets.attendeesCsv(req.user!, param(req, "id"));
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader(
      "content-disposition",
      `attachment; filename="attendees-${param(req, "id")}.csv"`,
    );
    res.send(`\uFEFF${csv}`); // BOM so Excel reads UTF-8 (Hindi names)
  });
  router.post(
    "/events/:id/checkin",
    signedIn,
    validate({ params: idParamsSchema, body: checkInRequestSchema }),
    async (req, res) => {
      const { qrToken } = req.body as z.infer<typeof checkInRequestSchema>;
      res.json(await tickets.checkIn(req.user!, param(req, "id"), { qrToken }));
    },
  );
  router.post(
    "/events/:id/tickets/:ticketId/checkin",
    signedIn,
    validate({ params: z.object({ id: objectIdSchema, ticketId: objectIdSchema }) }),
    async (req, res) => {
      res.json(
        await tickets.checkIn(req.user!, param(req, "id"), { ticketId: param(req, "ticketId") }),
      );
    },
  );

  // ---------- buyers ----------
  router.post(
    "/ticket-orders",
    signedIn,
    validate({ body: ticketOrderRequestSchema }),
    async (req, res) => {
      const order = await tickets.reserve(req.user!, req.body as TicketOrderRequest);
      res.status(201).json(await tickets.toDto(order, req.user!.id));
    },
  );
  router.get("/ticket-orders/mine", signedIn, async (req, res) => {
    res.json(await tickets.listMine(req.user!));
  });
  router.get("/ticket-orders/:id", signedIn, withId, async (req, res) => {
    res.json(await tickets.getForViewer(req.user!, param(req, "id")));
  });

  return router;
}
