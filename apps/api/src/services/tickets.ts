import { randomBytes } from "node:crypto";
import {
  HOLD_MINUTES,
  addDays,
  convenienceFeePaise,
  istDate,
  type Attendee,
  type CheckInResult,
  type EventDashboard,
  type TicketOrder,
  type TicketOrderRequest,
} from "@townplay/shared";
import type { Logger } from "pino";
import { Types } from "mongoose";
import { bookingCode } from "../lib/bookingCode.js";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { EventModel, type EventRaw } from "../models/event.js";
import { TicketModel } from "../models/ticket.js";
import {
  TicketOrderModel,
  type TicketOrderDoc,
  type TicketOrderRaw,
} from "../models/ticketOrder.js";
import { UserModel } from "../models/user.js";
import { audit } from "./audit.js";
import type { RefundStatus } from "./bookings.js";
import type { EmailSender } from "./email.js";
import {
  eventCancelledEmail,
  eventReminderEmail,
  ticketConfirmedEmail,
  type EventEmailInfo,
} from "./emailTemplates.js";
import { loadOwnedEvent } from "./events.js";
import type { SettingsService } from "./settings.js";

const oid = (id: string) => new Types.ObjectId(id);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface TicketRefunder {
  refundTicketOrder(
    orderId: Types.ObjectId,
    amountPaise: number,
    reason: string,
  ): Promise<RefundStatus>;
}

type Item = { tierId: Types.ObjectId; qty: number };

export function createTicketService(deps: {
  settings: SettingsService;
  email: EmailSender;
  logger: Logger;
  webOrigin: string;
  now?: () => Date;
}) {
  const { settings, email, logger, webOrigin, now = () => new Date() } = deps;
  let refunder: TicketRefunder | undefined;

  // ---------- capacity ----------

  /**
   * Takes `qty` from each tier atomically (`remaining >= qty` in the filter, so it can never go
   * negative under any concurrency). All-or-nothing: on a sold-out tier the earlier ones are
   * given back.
   */
  async function take(
    eventId: Types.ObjectId,
    items: Item[],
    filter: Record<string, unknown> = {},
  ): Promise<boolean> {
    const done: Item[] = [];
    for (const item of items) {
      const res = await EventModel.updateOne(
        {
          _id: eventId,
          ...filter,
          tiers: { $elemMatch: { _id: item.tierId, remaining: { $gte: item.qty } } },
        },
        { $inc: { "tiers.$.remaining": -item.qty } },
      );
      if (res.modifiedCount !== 1) {
        await give(eventId, done);
        return false;
      }
      done.push(item);
    }
    return true;
  }

  async function give(eventId: Types.ObjectId, items: Item[]) {
    for (const item of items) {
      await EventModel.updateOne(
        { _id: eventId, "tiers._id": item.tierId },
        { $inc: { "tiers.$.remaining": item.qty } },
      );
    }
  }

  // ---------- emails ----------

  async function emailFor(
    order: TicketOrderRaw,
    build: (to: string, info: EventEmailInfo) => ReturnType<typeof ticketConfirmedEmail>,
  ) {
    try {
      const [user, event] = await Promise.all([
        UserModel.findById(order.userId, { email: 1 }).lean(),
        EventModel.findById(order.eventId, { title: 1, startsAt: 1, address: 1 }).lean(),
      ]);
      if (!user?.email || !event) return;
      await email.send(
        build(user.email, {
          orderId: String(order._id),
          code: order.code,
          title: event.title,
          startsAt: event.startsAt,
          address: event.address,
          tickets: order.items.reduce((s, i) => s + i.qty, 0),
          totalPaise: order.totalPaise + order.convenienceFeePaise,
        }),
      );
    } catch (err) {
      logger.error({ err, orderId: String(order._id) }, "ticket email failed");
    }
  }

  // ---------- orders ----------

  async function issueTickets(order: TicketOrderRaw) {
    const existing = await TicketModel.countDocuments({ ticketOrderId: order._id });
    if (existing > 0) return; // idempotent
    await TicketModel.insertMany(
      order.items.flatMap((item) =>
        Array.from({ length: item.qty }, () => ({
          ticketOrderId: order._id,
          eventId: order.eventId,
          tierId: item.tierId,
          tierName: item.tierName,
          userId: order.userId,
          holderName: order.buyer.name,
          qrToken: randomBytes(18).toString("base64url"),
        })),
      ),
    );
    await emailFor(order, (to, info) => ticketConfirmedEmail(to, info, webOrigin));
  }

  async function reserve(user: AuthUser, req: TicketOrderRequest): Promise<TicketOrderDoc> {
    const event = await EventModel.findOne({
      _id: oid(req.eventId),
      status: "published",
      businessActive: true,
    }).lean();
    if (!event) throw notFound("Event");
    if (event.startsAt <= now())
      throw new HttpError(409, "EVENT_STARTED", "Ticket sales have closed");
    const lines = req.items.map((i) => {
      const tier = event.tiers.find((t) => String(t._id) === i.tierId);
      if (!tier)
        throw new HttpError(400, "VALIDATION_FAILED", "Unknown ticket type", { tierId: i.tierId });
      return { tierId: tier._id, tierName: tier.name, qty: i.qty, pricePaise: tier.pricePaise };
    });
    if (!(await take(event._id, lines, { status: "published" }))) {
      throw new HttpError(409, "SOLD_OUT", "Not enough tickets left");
    }
    const totalPaise = lines.reduce((s, l) => s + l.qty * l.pricePaise, 0);
    const fee = convenienceFeePaise(totalPaise, (await settings.get()).convenienceFee);
    const free = totalPaise + fee === 0;
    let order: TicketOrderDoc;
    try {
      order = await createWithCode({
        eventId: event._id,
        businessId: event.businessId,
        userId: oid(user.id),
        buyer: req.buyer,
        items: lines,
        totalPaise,
        convenienceFeePaise: fee,
        status: free ? "paid" : "pending_payment",
        ...(free
          ? { paidAt: now() }
          : { holdExpiresAt: new Date(now().getTime() + HOLD_MINUTES * 60_000) }),
      });
    } catch (err) {
      await give(event._id, lines);
      throw err;
    }
    if (free) await issueTickets(order.toObject<TicketOrderRaw>()); // RSVP
    return order;
  }

  async function createWithCode(fields: Record<string, unknown>): Promise<TicketOrderDoc> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await TicketOrderModel.create({ ...fields, code: `E${bookingCode(5)}` });
      } catch (err) {
        const dup = typeof err === "object" && err && "code" in err && err.code === 11000;
        if (!dup || attempt >= 3) throw err;
      }
    }
  }

  /**
   * Called when an order's payment is captured. A pending order still holds its tickets (capacity
   * is only released when the expiry job flips it to expired), so it is simply marked paid. An
   * expired order re-takes capacity if any is left; otherwise "conflict" (caller refunds).
   */
  async function confirmPaid(orderId: string): Promise<"confirmed" | "already" | "conflict"> {
    const at = now();
    const paid = await TicketOrderModel.findOneAndUpdate(
      { _id: oid(orderId), status: "pending_payment" },
      { $set: { status: "paid", paidAt: at }, $unset: { holdExpiresAt: 1 } },
      { new: true },
    ).lean();
    if (paid) {
      await issueTickets(paid);
      return "confirmed";
    }
    const order = await TicketOrderModel.findById(orderId).lean();
    if (!order) throw notFound("Order");
    if (order.status === "paid" || order.status === "refunded") return "already";
    if (order.status !== "expired") return "conflict";
    const event = await EventModel.findById(order.eventId, { status: 1, startsAt: 1 }).lean();
    if (
      event?.status !== "published" ||
      !(await take(order.eventId, order.items, { status: "published" }))
    ) {
      return "conflict";
    }
    const revived = await TicketOrderModel.findOneAndUpdate(
      { _id: order._id, status: "expired" },
      { $set: { status: "paid", paidAt: at } },
      { new: true },
    ).lean();
    if (!revived) {
      await give(order.eventId, order.items);
      return "conflict";
    }
    await issueTickets(revived);
    return "confirmed";
  }

  /** Paid for, but the tickets could not be honoured: cancel and refund everything paid. */
  async function systemCancel(orderId: string, reason: string) {
    const order = await TicketOrderModel.findById(orderId);
    if (!order) return;
    const amount = order.totalPaise + order.convenienceFeePaise;
    order.status = "cancelled";
    await order.save();
    if (refunder && amount > 0) {
      const status = await refunder.refundTicketOrder(order._id, amount, reason);
      if (status !== "failed") {
        order.status = "refunded";
        order.refundPaise = amount;
        await order.save();
      }
    }
  }

  /** Unpaid holds past expiry give their tickets back (job). */
  async function expireHolds(): Promise<number> {
    const stale = await TicketOrderModel.find({
      status: "pending_payment",
      holdExpiresAt: { $lte: now() },
    }).lean();
    let n = 0;
    for (const order of stale) {
      const res = await TicketOrderModel.updateOne(
        { _id: order._id, status: "pending_payment" },
        { $set: { status: "expired" } },
      );
      if (res.modifiedCount === 1) {
        await give(order.eventId, order.items);
        n++;
      }
    }
    return n;
  }

  /** Owner (or admin) cancels an event: every paid order is refunded in full, tickets void. */
  async function cancelEvent(user: AuthUser, eventId: string, reason: string) {
    const event = await loadOwnedEvent(user, eventId);
    if (event.status === "cancelled" || event.status === "completed") {
      throw new HttpError(409, "CONFLICT", `Event is ${event.status}`);
    }
    event.status = "cancelled";
    event.cancelReason = reason;
    await event.save();
    await audit(user.id, "event.cancel", "event", eventId, { reason });
    await TicketOrderModel.updateMany(
      { eventId: event._id, status: "pending_payment" },
      { $set: { status: "expired" } },
    );
    const paid = await TicketOrderModel.find({ eventId: event._id, status: "paid" });
    for (const order of paid) {
      const amount = order.totalPaise + order.convenienceFeePaise;
      let refunded = 0;
      if (amount > 0 && refunder) {
        try {
          const status = await refunder.refundTicketOrder(
            order._id,
            amount,
            `Event cancelled: ${reason}`,
          );
          if (status !== "failed") refunded = amount;
        } catch (err) {
          logger.error({ err, orderId: String(order._id) }, "event refund failed");
        }
      }
      order.status =
        amount > 0 && refunded === 0 ? "cancelled" : amount > 0 ? "refunded" : "cancelled";
      order.refundPaise = refunded;
      await order.save();
      await TicketModel.updateMany({ ticketOrderId: order._id }, { $set: { status: "void" } });
      await emailFor(order.toObject<TicketOrderRaw>(), (to, info) =>
        eventCancelledEmail(to, { ...info, refundPaise: refunded, reason }, webOrigin),
      );
    }
    return event;
  }

  // ---------- reads ----------

  async function toDtos(orders: TicketOrderRaw[], viewerId: string | null): Promise<TicketOrder[]> {
    const events = await EventModel.find({ _id: { $in: orders.map((o) => o.eventId) } }).lean();
    const tickets = await TicketModel.find({
      ticketOrderId: { $in: orders.map((o) => o._id) },
    }).lean();
    const eventById = new Map(events.map((e) => [String(e._id), e]));
    return orders.map((o) => {
      const e = eventById.get(String(o.eventId));
      const [lng = 0, lat = 0] = e?.geo?.coordinates ?? [];
      const own = viewerId !== null && String(o.userId) === viewerId;
      return {
        id: String(o._id),
        code: o.code,
        event: {
          id: String(o.eventId),
          slug: e?.slug ?? "",
          citySlug: e?.citySlug ?? "",
          title: e?.title ?? "",
          startsAt: e?.startsAt.toISOString() ?? "",
          endsAt: e?.endsAt.toISOString() ?? "",
          address: e?.address ?? "",
          location: { lat, lng },
        },
        buyer: { name: o.buyer.name, phone: o.buyer.phone },
        items: o.items.map((i) => ({
          tierId: String(i.tierId),
          tierName: i.tierName,
          qty: i.qty,
          pricePaise: i.pricePaise,
        })),
        totalPaise: o.totalPaise,
        convenienceFeePaise: o.convenienceFeePaise,
        status: o.status,
        holdExpiresAt:
          o.status === "pending_payment" ? (o.holdExpiresAt?.toISOString() ?? null) : null,
        refundPaise: o.refundPaise ?? 0,
        tickets: tickets
          .filter((t) => String(t.ticketOrderId) === String(o._id))
          .map((t) => ({
            id: String(t._id),
            tierId: String(t.tierId),
            tierName: t.tierName,
            holderName: t.holderName,
            qrToken: own && t.status === "valid" ? t.qrToken : null,
            status: t.status,
            checkedInAt: t.checkedInAt?.toISOString() ?? null,
          })),
        createdAt: o.createdAt.toISOString(),
      };
    });
  }

  async function toDto(order: TicketOrderRaw | TicketOrderDoc, viewerId: string | null) {
    const raw = "toObject" in order ? order.toObject<TicketOrderRaw>() : order;
    return (await toDtos([raw], viewerId))[0]!;
  }

  async function listMine(user: AuthUser) {
    const orders = await TicketOrderModel.find({ userId: oid(user.id), status: { $ne: "expired" } })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return toDtos(orders, user.id);
  }

  async function getForViewer(user: AuthUser, orderId: string) {
    const order = await TicketOrderModel.findById(orderId).lean();
    if (!order) throw notFound("Order");
    if (String(order.userId) !== user.id) {
      await loadOwnedEvent(user, String(order.eventId)).catch(() => {
        throw notFound("Order");
      });
    }
    return toDto(order, user.id);
  }

  // ---------- organiser ----------

  async function checkIn(
    user: AuthUser,
    eventId: string,
    by: { qrToken: string } | { ticketId: string },
  ): Promise<CheckInResult> {
    const event = await loadOwnedEvent(user, eventId);
    const ticket = await TicketModel.findOne(
      "qrToken" in by ? { qrToken: by.qrToken } : { _id: oid(by.ticketId) },
    ).lean();
    if (!ticket || ticket.status !== "valid") return { result: "invalid", ticket: null };
    const summary = (checkedInAt: Date | null) => ({
      id: String(ticket._id),
      holderName: ticket.holderName,
      tierName: ticket.tierName,
      checkedInAt: checkedInAt?.toISOString() ?? null,
    });
    if (String(ticket.eventId) !== String(event._id))
      return { result: "wrong_event", ticket: summary(ticket.checkedInAt ?? null) };
    const at = now();
    const res = await TicketModel.updateOne(
      { _id: ticket._id, checkedInAt: null, status: "valid" },
      { $set: { checkedInAt: at, checkedInBy: oid(user.id) } },
    );
    if (res.modifiedCount === 1) return { result: "ok", ticket: summary(at) };
    const fresh = await TicketModel.findById(ticket._id, { checkedInAt: 1 }).lean();
    return { result: "already", ticket: summary(fresh?.checkedInAt ?? null) };
  }

  async function attendees(user: AuthUser, eventId: string, q?: string): Promise<Attendee[]> {
    const event = await loadOwnedEvent(user, eventId);
    const orders = await TicketOrderModel.find({ eventId: event._id, status: "paid" }).lean();
    const byId = new Map(orders.map((o) => [String(o._id), o]));
    const tickets = await TicketModel.find({ eventId: event._id, status: "valid" })
      .sort({ holderName: 1 })
      .lean();
    const re = q ? new RegExp(escapeRegex(q), "i") : null;
    return tickets
      .map((t) => {
        const o = byId.get(String(t.ticketOrderId));
        return {
          ticketId: String(t._id),
          orderCode: o?.code ?? "",
          holderName: t.holderName,
          buyerName: o?.buyer.name ?? "",
          buyerPhone: o?.buyer.phone ?? "",
          tierName: t.tierName,
          checkedInAt: t.checkedInAt?.toISOString() ?? null,
        };
      })
      .filter(
        (a) =>
          !re ||
          re.test(a.holderName) ||
          re.test(a.buyerName) ||
          re.test(a.buyerPhone) ||
          re.test(a.orderCode),
      );
  }

  async function attendeesCsv(user: AuthUser, eventId: string): Promise<string> {
    const rows = await attendees(user, eventId);
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    // Formula-injection guard for spreadsheet apps.
    const safe = (v: string) => cell(/^[=+\-@]/.test(v) ? `'${v}` : v);
    const header = ["Order", "Ticket holder", "Buyer", "Phone", "Ticket type", "Checked in at"];
    const lines = rows.map((a) =>
      [a.orderCode, a.holderName, a.buyerName, a.buyerPhone, a.tierName, a.checkedInAt ?? ""]
        .map(safe)
        .join(","),
    );
    return [header.join(","), ...lines].join("\n") + "\n";
  }

  async function dashboard(user: AuthUser, eventId: string): Promise<EventDashboard> {
    const event = await loadOwnedEvent(user, eventId);
    const orders = await TicketOrderModel.find({
      eventId: event._id,
      status: { $in: ["paid", "pending_payment"] },
    }).lean();
    const checkedIn = await TicketModel.countDocuments({
      eventId: event._id,
      status: "valid",
      checkedInAt: { $ne: null },
    });
    const tiers = event.tiers.map((t) => {
      let sold = 0;
      let held = 0;
      let revenue = 0;
      for (const o of orders) {
        for (const i of o.items) {
          if (String(i.tierId) !== String(t._id)) continue;
          if (o.status === "paid") {
            sold += i.qty;
            revenue += i.qty * i.pricePaise;
          } else held += i.qty;
        }
      }
      return {
        tierId: String(t._id),
        name: t.name,
        capacity: t.capacity,
        sold,
        held,
        revenuePaise: revenue,
      };
    });
    return {
      eventId,
      tiers,
      ticketsSold: tiers.reduce((s, t) => s + t.sold, 0),
      revenuePaise: tiers.reduce((s, t) => s + t.revenuePaise, 0),
      checkedIn,
    };
  }

  /** Day-before reminder emails (job, hourly; each order is reminded once). */
  async function sendReminders(): Promise<number> {
    const tomorrow = addDays(istDate(now()), 1);
    const from = new Date(`${tomorrow}T00:00:00+05:30`);
    const to = new Date(`${addDays(tomorrow, 1)}T00:00:00+05:30`);
    const events: Pick<EventRaw, "_id">[] = await EventModel.find(
      { status: "published", startsAt: { $gte: from, $lt: to } },
      { _id: 1 },
    ).lean();
    let n = 0;
    for (const e of events) {
      const orders = await TicketOrderModel.find({
        eventId: e._id,
        status: "paid",
        reminderSentAt: { $exists: false },
      }).lean();
      for (const o of orders) {
        const claimed = await TicketOrderModel.updateOne(
          { _id: o._id, reminderSentAt: { $exists: false } },
          { $set: { reminderSentAt: now() } },
        );
        if (claimed.modifiedCount !== 1) continue;
        await emailFor(o, (to2, info) => eventReminderEmail(to2, info, webOrigin));
        n++;
      }
    }
    return n;
  }

  return {
    setRefunder: (r: TicketRefunder) => {
      refunder = r;
    },
    reserve,
    confirmPaid,
    systemCancel,
    expireHolds,
    cancelEvent,
    toDto,
    listMine,
    getForViewer,
    checkIn,
    attendees,
    attendeesCsv,
    dashboard,
    sendReminders,
  };
}

export type TicketService = ReturnType<typeof createTicketService>;
