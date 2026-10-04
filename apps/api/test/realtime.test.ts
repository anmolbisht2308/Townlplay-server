import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BOOKING_EVENT, SOCKET_PATH, bookableDates, type BookingEvent } from "@townplay/shared";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { attachRealtime } from "../src/realtime.js";
import { seed } from "../src/scripts/seed.js";
import { agent, liveVenue } from "./factories.js";
import { setupApp, signInWithOtp, WEB_ORIGIN } from "./helpers.js";

describe("live calendar over Socket.io", () => {
  const ctx = setupApp();
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    await seed(undefined);
    server = createServer(ctx.app);
    attachRealtime(server, {
      auth: ctx.auth,
      env: ctx.env,
      logger: createLogger(ctx.env),
      events: ctx.events,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    sockets.forEach((s) => s.disconnect());
    sockets.length = 0;
    await new Promise((resolve) => server.close(resolve));
  });

  function socketFor(cookies: string[]) {
    const socket = connect(url, {
      path: SOCKET_PATH,
      transports: ["websocket"],
      extraHeaders: { cookie: cookies.join("; "), origin: WEB_ORIGIN },
    });
    sockets.push(socket);
    return socket;
  }

  it("pushes booking events to owners who joined their venue, and refuses others", async () => {
    const owner = await agent(ctx, "owner@example.com");
    const { venueId } = await liveVenue(ctx, owner);
    const resourceId = (await owner.get(`/v1/venues/${venueId}/resources`)).body[0].id;

    const ownerSocket = socketFor(await signInWithOtp(ctx, "owner@example.com"));
    const joined = await ownerSocket.emitWithAck("join", venueId);
    expect(joined).toEqual({ ok: true });

    const otherSocket = socketFor(await signInWithOtp(ctx, "other@example.com"));
    expect(await otherSocket.emitWithAck("join", venueId)).toEqual({ ok: false });

    const received = new Promise<BookingEvent>((resolve) =>
      ownerSocket.once(BOOKING_EVENT, resolve),
    );
    const date = bookableDates()[1]!;
    await owner
      .post(`/v1/venues/${venueId}/bookings`, {
        resourceId,
        date,
        startTimes: ["06:00"],
        source: "block",
      })
      .expect(201);
    expect(await received).toMatchObject({ type: "created", venueId, date });
  });

  it("rejects connections without a session", async () => {
    const anon = socketFor([]);
    const error = await new Promise<Error>((resolve) => anon.once("connect_error", resolve));
    expect(error.message).toBe("UNAUTHENTICATED");
  });
});
