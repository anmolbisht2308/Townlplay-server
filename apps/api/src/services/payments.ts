import { createHash, randomBytes } from "node:crypto";
import {
  paidOnlinePaise,
  type CreateOrderRequest,
  type OrderResponse,
  type PaymentResult,
  type VerifyPaymentRequest,
} from "@townplay/shared";
import type { Logger } from "pino";
import { Types } from "mongoose";
import { HttpError, notFound } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BookingModel } from "../models/booking.js";
import { PaymentModel, type PaymentDoc } from "../models/payment.js";
import { ProcessedEventModel } from "../models/processedEvent.js";
import { BookingShareModel } from "../models/bookingShare.js";
import { MembershipModel } from "../models/membership.js";
import { TicketOrderModel } from "../models/ticketOrder.js";

type RefType = "booking" | "ticketOrder" | "groupShare" | "membership";
import type { BookingService, RefundStatus } from "./bookings.js";
import type { MembershipService } from "./memberships.js";
import type { Notifier } from "./notify.js";
import type { PaymentGateway } from "./paymentGateway.js";
import type { PayoutService } from "./payouts.js";
import type { ShareService } from "./shares.js";
import type { TicketService } from "./tickets.js";

interface WebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; error_description?: string } };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number; status?: string } };
  };
}

/**
 * Online payments (docs/PLAN.md §4). The webhook is the source of truth; `verify` (and the fake
 * test-mode pay) run the same capture path so a closed browser never loses a booking. Capture,
 * refund and webhook handling are idempotent.
 */
export function createPaymentsService(deps: {
  gateway: PaymentGateway;
  bookings: BookingService;
  tickets: TicketService;
  shares: ShareService;
  memberships: MembershipService;
  payouts: PayoutService;
  notifier: Notifier;
  logger: Logger;
  now?: () => Date;
}) {
  const {
    gateway,
    bookings,
    tickets,
    shares,
    memberships,
    payouts,
    notifier,
    logger,
    now = () => new Date(),
  } = deps;

  async function resultFor(refType: RefType, refId: string): Promise<PaymentResult> {
    const doc =
      refType === "booking"
        ? await BookingModel.findById(refId, { status: 1 }).lean()
        : refType === "ticketOrder"
          ? await TicketOrderModel.findById(refId, { status: 1 }).lean()
          : refType === "membership"
            ? await MembershipModel.findById(refId, { status: 1 }).lean()
            : await BookingShareModel.findById(refId, { status: 1 }).lean();
    return { refType, refId, status: doc?.status ?? "unknown" };
  }

  async function createOrder(
    user: AuthUser,
    req: CreateOrderRequest,
    opts: { viaShareToken?: boolean } = {},
  ): Promise<OrderResponse> {
    const base = { provider: gateway.provider, keyId: gateway.keyId, currency: "INR" as const };
    const at = now();
    let target: {
      refType: RefType;
      refId: Types.ObjectId;
      businessId: Types.ObjectId;
      userId: Types.ObjectId;
      code: string;
      advancePaise: number;
      feePaise: number;
      kind: "booking_advance" | "ticket" | "booking_share" | "membership";
    };
    if (req.bookingId) {
      const booking = await BookingModel.findById(req.bookingId);
      if (!booking || String(booking.userId) !== user.id) throw notFound("Booking");
      if (
        booking.status !== "pending_payment" ||
        !booking.holdExpiresAt ||
        booking.holdExpiresAt <= at
      ) {
        throw new HttpError(409, "HOLD_EXPIRED", "This hold has expired. Pick the slots again.");
      }
      if (paidOnlinePaise(booking.amount) === 0) {
        // Nothing to pay online (0% advance): confirm right away.
        const result = await bookings.confirmPaid(req.bookingId);
        if (result === "conflict")
          throw new HttpError(409, "SLOT_TAKEN", "One of these slots was just booked.");
        return {
          ...base,
          orderId: "",
          amountPaise: 0,
          result: await resultFor("booking", req.bookingId),
        };
      }
      target = {
        refType: "booking",
        refId: booking._id,
        businessId: booking.businessId,
        userId: booking.userId!,
        code: booking.code,
        advancePaise: booking.amount.advancePaise,
        feePaise: booking.amount.convenienceFeePaise,
        kind: "booking_advance",
      };
    } else if (req.shareId) {
      const share = await shares.payable(user, req.shareId, Boolean(opts.viaShareToken));
      target = {
        refType: "groupShare",
        refId: share._id,
        businessId: share.businessId,
        userId: new Types.ObjectId(user.id),
        code: `S${String(share._id).slice(-6).toUpperCase()}`,
        advancePaise: share.amountPaise,
        feePaise: share.feePaise,
        kind: "booking_share",
      };
    } else if (req.membershipId) {
      const m = await memberships.payable(user, req.membershipId);
      target = {
        refType: "membership",
        refId: m._id,
        businessId: m.businessId,
        userId: m.userId,
        code: m.code,
        advancePaise: m.pricePaise,
        feePaise: m.convenienceFeePaise,
        kind: "membership",
      };
    } else {
      const order = await TicketOrderModel.findById(req.ticketOrderId);
      if (!order || String(order.userId) !== user.id) throw notFound("Order");
      if (order.status !== "pending_payment" || !order.holdExpiresAt || order.holdExpiresAt <= at) {
        throw new HttpError(409, "HOLD_EXPIRED", "This hold has expired. Pick your tickets again.");
      }
      target = {
        refType: "ticketOrder",
        refId: order._id,
        businessId: order.businessId,
        userId: order.userId,
        code: order.code,
        advancePaise: order.totalPaise,
        feePaise: order.convenienceFeePaise,
        kind: "ticket",
      };
    }
    const amountPaise = target.advancePaise + target.feePaise;
    const existing = await PaymentModel.findOne({
      refType: target.refType,
      refId: target.refId,
      userId: target.userId,
      status: "created",
    }).lean();
    if (existing)
      return {
        ...base,
        orderId: existing.razorpayOrderId,
        amountPaise: existing.amountPaise,
        result: null,
      };
    const gatewayOrder = await gateway.createOrder({
      amountPaise,
      receipt: target.code,
      notes: { refType: target.refType, refId: String(target.refId), code: target.code },
    });
    await PaymentModel.create({
      kind: target.kind,
      refType: target.refType,
      refId: target.refId,
      businessId: target.businessId,
      userId: target.userId,
      provider: gateway.provider,
      amountPaise,
      advancePaise: target.advancePaise,
      feePaise: target.feePaise,
      razorpayOrderId: gatewayOrder.id,
    });
    return { ...base, orderId: gatewayOrder.id, amountPaise, result: null };
  }

  /** Marks the order paid (once) and confirms its booking; a late payment for a taken slot is refunded in full. */
  async function handleCaptured(orderId: string, paymentId: string): Promise<PaymentDoc> {
    const claimed = await PaymentModel.findOneAndUpdate(
      { razorpayOrderId: orderId, status: { $in: ["created", "failed"] } },
      { $set: { status: "paid", razorpayPaymentId: paymentId, paidAt: now() } },
      { new: true },
    );
    if (!claimed) {
      const existing = await PaymentModel.findOne({ razorpayOrderId: orderId });
      if (!existing) throw new HttpError(404, "NOT_FOUND", "Unknown order");
      return existing; // already captured: replay
    }
    const refId = String(claimed.refId);
    if (claimed.refType === "groupShare") {
      const result = await shares.confirmPaid(
        refId,
        claimed.userId ? String(claimed.userId) : null,
      );
      if (result === "conflict") {
        await shares.systemRefund(refId, "The game filled up before your payment completed");
      } else if (result === "confirmed") {
        await payouts.transferForPayment(claimed);
      }
    } else if (claimed.refType === "membership") {
      const result = await memberships.confirmPaid(refId);
      if (result === "conflict") {
        await memberships.systemRefund(refId, "The batch filled up before your payment completed");
      } else if (result === "confirmed") {
        await payouts.transferForPayment(claimed);
      }
    } else if (claimed.refType === "ticketOrder") {
      const result = await tickets.confirmPaid(refId);
      if (result === "conflict") {
        await tickets.systemCancel(refId, "Tickets sold out before your payment completed");
      } else if (result === "confirmed") {
        await payouts.transferForPayment(claimed);
      }
    } else {
      const result = await bookings.confirmPaid(refId);
      if (result === "conflict") {
        await bookings.systemCancel(
          refId,
          "The slot was booked by someone else before your payment completed",
        );
      } else if (result === "confirmed") {
        await payouts.transferForPayment(claimed);
      }
    }
    return (await PaymentModel.findById(claimed._id))!;
  }

  async function markFailed(orderId: string, paymentId: string | undefined) {
    await PaymentModel.updateOne(
      { razorpayOrderId: orderId, status: "created" },
      { $set: { status: "failed", ...(paymentId ? { razorpayPaymentId: paymentId } : {}) } },
    );
  }

  async function verify(user: AuthUser, req: VerifyPaymentRequest) {
    if (
      !gateway.verifyCheckoutSignature(
        req.razorpayOrderId,
        req.razorpayPaymentId,
        req.razorpaySignature,
      )
    ) {
      throw new HttpError(400, "INVALID_SIGNATURE", "Payment could not be verified");
    }
    const payment = await PaymentModel.findOne({ razorpayOrderId: req.razorpayOrderId }).lean();
    if (!payment || String(payment.userId) !== user.id) throw notFound("Payment");
    await handleCaptured(req.razorpayOrderId, req.razorpayPaymentId);
    return resultFor(payment.refType, String(payment.refId));
  }

  /** Test mode only: what Razorpay Checkout + webhook would do. */
  async function fakePay(user: AuthUser, orderId: string, outcome: "success" | "failure") {
    if (gateway.provider !== "fake") throw new HttpError(404, "NOT_FOUND", "Not found");
    const payment = await PaymentModel.findOne({ razorpayOrderId: orderId }).lean();
    if (!payment || String(payment.userId) !== user.id) throw notFound("Payment");
    const paymentId = `pay_fake_${randomBytes(6).toString("hex")}`;
    if (outcome === "failure") await markFailed(orderId, paymentId);
    else await handleCaptured(orderId, paymentId);
    return resultFor(payment.refType, String(payment.refId));
  }

  /** Refunds part or all of an online payment (reversing the Route transfer first). */
  async function refundFor(
    refType: RefType,
    refId: Types.ObjectId,
    amountPaise: number,
    reason: string,
  ): Promise<RefundStatus> {
    const payment = await PaymentModel.findOne({
      refType,
      refId,
      status: { $in: ["paid", "partially_refunded"] },
    });
    if (!payment?.razorpayPaymentId) return "none";
    const already = payment.refunds
      .filter((r) => r.status !== "failed")
      .reduce((s, r) => s + r.amountPaise, 0);
    const amount = Math.min(amountPaise, payment.amountPaise - already);
    if (amount <= 0) return "none";
    await payouts.reverseForRefund(payment, amount);
    const refund = await gateway.refund(payment.razorpayPaymentId, amount, {
      refType,
      refId: String(refId),
      reason,
    });
    payment.refunds.push({
      razorpayRefundId: refund.id,
      amountPaise: amount,
      status: refund.status,
      reason,
      at: now(),
    });
    payment.status = already + amount >= payment.amountPaise ? "refunded" : "partially_refunded";
    await payment.save();
    if (refund.status === "processed") await notifyRefund(payment, amount);
    return refund.status;
  }

  async function notifyRefund(payment: PaymentDoc, amountPaise: number) {
    if (payment.refType !== "booking") return; // ticket refunds are covered by the cancellation email
    const booking = await BookingModel.findById(payment.refId).lean();
    if (!booking) return;
    await notifier.refundProcessed(await bookings.toDto(booking, "player"), amountPaise, {
      userId: booking.userId ? String(booking.userId) : null,
    });
  }

  async function onRefundEvent(entity: { id?: string; payment_id?: string; status?: string }) {
    if (!entity.id || !entity.payment_id) return;
    const payment = await PaymentModel.findOne({ razorpayPaymentId: entity.payment_id });
    const refund = payment?.refunds.find((r) => r.razorpayRefundId === entity.id);
    if (!payment || !refund) return;
    const next =
      entity.status === "processed"
        ? "processed"
        : entity.status === "failed"
          ? "failed"
          : refund.status;
    if (next === refund.status) return;
    refund.status = next;
    await payment.save();
    await BookingModel.updateOne(
      { _id: payment.refId, "cancellation.refundStatus": { $in: ["pending", "failed"] } },
      { $set: { "cancellation.refundStatus": next } },
    );
    await MembershipModel.updateOne(
      { _id: payment.refId, "cancellation.refundStatus": { $in: ["pending", "failed"] } },
      { $set: { "cancellation.refundStatus": next } },
    );
    if (next === "processed") await notifyRefund(payment, refund.amountPaise);
  }

  /**
   * Razorpay webhook. Verifies the signature over the raw body, then records the event id; a
   * replay hits the unique id and is acknowledged without doing anything.
   */
  async function handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    eventId: string | undefined,
  ) {
    if (!signature || !gateway.verifyWebhookSignature(rawBody, signature)) {
      throw new HttpError(400, "INVALID_SIGNATURE", "Invalid webhook signature");
    }
    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as WebhookBody;
    } catch {
      throw new HttpError(400, "VALIDATION_FAILED", "Invalid JSON");
    }
    const id = eventId || createHash("sha256").update(rawBody).digest("hex");
    try {
      await ProcessedEventModel.create({
        _id: id,
        provider: gateway.provider,
        type: body.event ?? "unknown",
      });
    } catch (err) {
      if (typeof err === "object" && err && "code" in err && err.code === 11000)
        return { duplicate: true };
      throw err;
    }
    try {
      const payment = body.payload?.payment?.entity;
      switch (body.event) {
        case "payment.captured":
          if (payment?.order_id && payment.id) await handleCaptured(payment.order_id, payment.id);
          break;
        case "payment.failed":
          if (payment?.order_id) await markFailed(payment.order_id, payment.id);
          break;
        case "refund.processed":
        case "refund.failed":
          await onRefundEvent(body.payload?.refund?.entity ?? {});
          break;
        default:
          logger.info({ event: body.event }, "ignored webhook event");
      }
      if (payment?.order_id) {
        await PaymentModel.updateOne(
          { razorpayOrderId: payment.order_id },
          { $push: { rawEvents: { $each: [{ id, event: body.event, at: now() }], $slice: -20 } } },
        );
      }
    } catch (err) {
      // Let Razorpay retry: forget the event so the retry is processed.
      await ProcessedEventModel.deleteOne({ _id: id });
      throw err;
    }
    return { duplicate: false };
  }

  return {
    createOrder,
    verify,
    fakePay,
    handleWebhook,
    handleCaptured,
    refundBooking: (id: Types.ObjectId, amount: number, reason: string) =>
      refundFor("booking", id, amount, reason),
    refundShare: (id: Types.ObjectId, amount: number, reason: string) =>
      refundFor("groupShare", id, amount, reason),
    refundTicketOrder: (id: Types.ObjectId, amount: number, reason: string) =>
      refundFor("ticketOrder", id, amount, reason),
    refundMembership: (id: Types.ObjectId, amount: number, reason: string) =>
      refundFor("membership", id, amount, reason),
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
