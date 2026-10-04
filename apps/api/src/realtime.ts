import type { Server as HttpServer } from "node:http";
import { BOOKING_EVENT, SOCKET_PATH, objectIdSchema } from "@townplay/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { Logger } from "pino";
import { Server } from "socket.io";
import type { Auth } from "./auth/auth.js";
import type { Env } from "./env.js";
import { toAuthUser, type AuthUser } from "./middleware/auth.js";
import type { BookingEventBus } from "./services/bookingEvents.js";
import { loadOwnedVenue } from "./services/listings.js";

/**
 * Socket.io for live owner calendars. Clients authenticate with the session cookie, then
 * `join` a venue they own; booking changes are pushed to the `venue:<id>` room.
 */
export function attachRealtime(
  httpServer: HttpServer,
  deps: { auth: Auth; env: Env; logger: Logger; events: BookingEventBus },
): Server {
  const io = new Server(httpServer, {
    path: SOCKET_PATH,
    cors: { origin: deps.env.WEB_ORIGIN, credentials: true },
  });

  io.use((socket, next) => {
    deps.auth.api
      .getSession({ headers: fromNodeHeaders(socket.request.headers) })
      .then((session) => {
        if (!session) return next(new Error("UNAUTHENTICATED"));
        (socket.data as { user?: AuthUser }).user = toAuthUser(session.user);
        next();
      })
      .catch((err: unknown) => {
        deps.logger.error({ err }, "socket auth failed");
        next(new Error("UNAUTHENTICATED"));
      });
  });

  io.on("connection", (socket) => {
    const user = (socket.data as { user: AuthUser }).user;
    socket.on("join", (venueId: unknown, ack?: (r: { ok: boolean }) => void) => {
      const parsed = objectIdSchema.safeParse(venueId);
      if (!parsed.success) return ack?.({ ok: false });
      loadOwnedVenue(user, parsed.data)
        .then(async () => {
          await socket.join(`venue:${parsed.data}`);
          ack?.({ ok: true });
        })
        .catch(() => ack?.({ ok: false }));
    });
  });

  deps.events.subscribe((event) => {
    io.to(`venue:${event.venueId}`).emit(BOOKING_EVENT, event);
  });
  return io;
}
