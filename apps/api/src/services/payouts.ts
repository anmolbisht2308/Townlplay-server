import type { AdminPayoutRow, Earnings, PayoutSetupRequest } from "@townplay/shared";
import type { Logger } from "pino";
import { Types } from "mongoose";
import { encryptSecret } from "../lib/crypto.js";
import { toPayoutInfo } from "../lib/dto.js";
import { HttpError } from "../lib/httpError.js";
import type { AuthUser } from "../middleware/auth.js";
import { BookingModel } from "../models/booking.js";
import { BookingShareModel } from "../models/bookingShare.js";
import { BusinessModel } from "../models/business.js";
import { PaymentModel, type PaymentDoc, type PaymentRaw } from "../models/payment.js";
import { PayoutModel } from "../models/payout.js";
import { VenueModel } from "../models/venue.js";
import { audit } from "./audit.js";
import { loadOwnedBusiness } from "./listings.js";
import type { PaymentGateway } from "./paymentGateway.js";

const refundedOf = (p: Pick<PaymentRaw, "refunds">) =>
  p.refunds.filter((r) => r.status !== "failed").reduce((sum, r) => sum + r.amountPaise, 0);

/** The venue's share of a payment: its advance minus refunds of that advance. */
export const venueShareOf = (p: Pick<PaymentRaw, "advancePaise" | "refunds" | "status">) =>
  p.status === "created" || p.status === "failed"
    ? 0
    : p.advancePaise - Math.min(refundedOf(p), p.advancePaise);

/** The platform keeps the fee unless refunds went beyond the advance (owner/system cancels). */
const platformShareOf = (
  p: Pick<PaymentRaw, "advancePaise" | "feePaise" | "refunds" | "status">,
) =>
  p.status === "created" || p.status === "failed"
    ? 0
    : p.feePaise - Math.min(p.feePaise, Math.max(0, refundedOf(p) - p.advancePaise));

const transferredOf = (p: Pick<PaymentRaw, "transfer">) =>
  p.transfer ? p.transfer.amountPaise - (p.transfer.reversedPaise ?? 0) : 0;

export function createPayoutService(deps: {
  gateway: PaymentGateway;
  mode: "route" | "manual";
  authSecret: string;
  logger: Logger;
}) {
  const { gateway, mode, authSecret, logger } = deps;

  async function setup(user: AuthUser, businessId: string, input: PayoutSetupRequest) {
    const business = await loadOwnedBusiness(user, businessId);
    business.set("payout", {
      ...(business.payout ?? {}),
      accountHolderName: input.accountHolderName,
      accountNumberSealed: encryptSecret(input.accountNumber, authSecret),
      accountLast4: input.accountNumber.slice(-4),
      ifsc: input.ifsc,
      status: mode === "manual" ? "active" : "pending",
    });
    if (mode === "route") {
      try {
        const account = await gateway.createLinkedAccount({
          businessId,
          name: business.name,
          email: business.email,
          phone: business.contactPhone,
          legalName: business.kyc?.legalName ?? business.name,
          accountHolderName: input.accountHolderName,
          accountNumber: input.accountNumber,
          ifsc: input.ifsc,
        });
        business.set("payout.razorpayLinkedAccountId", account.id);
        business.set("payout.status", account.status);
      } catch (err) {
        logger.error({ err, businessId }, "linked account creation failed");
        business.set("payout.status", "failed");
      }
    }
    await business.save();
    await audit(user.id, "business.payout_setup", "business", businessId, {
      mode,
      last4: input.accountNumber.slice(-4),
    });
    return business;
  }

  /** Route mode: move the venue's advance to its linked account once a payment is captured. */
  async function transferForPayment(payment: PaymentDoc): Promise<void> {
    if (mode !== "route" || payment.transfer || !payment.razorpayPaymentId) return;
    const business = await BusinessModel.findById(payment.businessId, { payout: 1 }).lean();
    const accountId = business?.payout?.razorpayLinkedAccountId;
    if (business?.payout?.status !== "active" || !accountId) return;
    try {
      const t = await gateway.transfer(payment.razorpayPaymentId, accountId, payment.advancePaise);
      payment.set("transfer", {
        razorpayTransferId: t.id,
        accountId,
        amountPaise: payment.advancePaise,
        reversedPaise: 0,
      });
      await payment.save();
    } catch (err) {
      logger.error({ err, paymentId: payment.id }, "route transfer failed");
    }
  }

  /** Before refunding in Route mode, pull the venue's part back from its linked account. */
  async function reverseForRefund(payment: PaymentDoc, refundPaise: number): Promise<void> {
    if (!payment.transfer) return;
    const remaining = payment.transfer.amountPaise - (payment.transfer.reversedPaise ?? 0);
    const amount = Math.min(refundPaise, remaining);
    if (amount <= 0) return;
    await gateway.reverseTransfer(payment.transfer.razorpayTransferId, amount);
    payment.set("transfer.reversedPaise", (payment.transfer.reversedPaise ?? 0) + amount);
  }

  async function earnings(
    user: AuthUser,
    businessId: string,
    from: string,
    to: string,
  ): Promise<Earnings> {
    if (from > to) throw new HttpError(400, "VALIDATION_FAILED", "`from` must not be after `to`");
    const business = await loadOwnedBusiness(user, businessId);
    const bookings = await BookingModel.find({
      businessId: business._id,
      date: { $gte: from, $lte: to },
      source: { $nin: ["block", "batch"] },
      status: { $nin: ["pending_payment", "expired"] },
    })
      .sort({ date: 1, startTime: 1 })
      .lean();
    const [payments, venues, payouts] = await Promise.all([
      PaymentModel.find({ refType: "booking", refId: { $in: bookings.map((b) => b._id) } }).lean(),
      VenueModel.find({ businessId: business._id }, { name: 1 }).lean(),
      PayoutModel.find({
        businessId: business._id,
        createdAt: {
          $gte: new Date(`${from}T00:00:00+05:30`),
          $lte: new Date(`${to}T23:59:59+05:30`),
        },
      }).lean(),
    ]);
    const paymentByBooking = new Map(payments.map((p) => [String(p.refId), p]));
    const venueName = new Map(venues.map((v) => [String(v._id), v.name]));
    // Open-game spots and split shares are paid online towards the venue balance.
    const shares = await BookingShareModel.find(
      { bookingId: { $in: bookings.map((b) => b._id) } },
      { bookingId: 1, status: 1, amountPaise: 1 },
    ).lean();
    const sharePayments = await PaymentModel.find({
      refType: "groupShare",
      refId: { $in: shares.map((x) => x._id) },
    }).lean();
    const bookingOfShare = new Map(shares.map((x) => [String(x._id), String(x.bookingId)]));
    const sharePaymentsByBooking = new Map<string, typeof sharePayments>();
    for (const sp of sharePayments) {
      const key = bookingOfShare.get(String(sp.refId)) ?? "";
      sharePaymentsByBooking.set(key, [...(sharePaymentsByBooking.get(key) ?? []), sp]);
    }
    const sharesPaid = new Map<string, number>();
    for (const x of shares) {
      if (x.status === "paid")
        sharesPaid.set(
          String(x.bookingId),
          (sharesPaid.get(String(x.bookingId)) ?? 0) + x.amountPaise,
        );
    }

    let bookedValue = 0;
    let advanceOnline = 0;
    let balanceCollected = 0;
    let refunds = 0;
    let fees = 0;
    let transferred = 0;
    const rows = bookings.map((b) => {
      const p = paymentByBooking.get(String(b._id));
      const all = [...(p ? [p] : []), ...(sharePaymentsByBooking.get(String(b._id)) ?? [])];
      const advance = all.reduce((sum, x) => sum + venueShareOf(x), 0);
      const refund = all.reduce((sum, x) => sum + refundedOf(x), 0);
      // At the venue the owner collects only what shares did not already cover online.
      const due = Math.max(0, b.amount.balancePaise - (sharesPaid.get(String(b._id)) ?? 0));
      const balance = b.balanceCollected?.method ? due : 0;
      if (b.status !== "cancelled") bookedValue += b.amount.totalPaise;
      advanceOnline += advance;
      balanceCollected += balance;
      refunds += refund;
      fees += all.reduce((sum, x) => sum + platformShareOf(x), 0);
      transferred += all.reduce((sum, x) => sum + transferredOf(x), 0);
      return {
        bookingId: String(b._id),
        code: b.code,
        date: b.date,
        startTime: b.startTime,
        venueName: venueName.get(String(b.venueId)) ?? "",
        status: b.status,
        source: b.source,
        totalPaise: b.amount.totalPaise,
        advanceOnlinePaise: advance,
        balanceCollectedPaise: balance,
        refundPaise: refund,
      };
    });
    // Membership and batch fees, by the day they were paid (IST).
    const membershipPayments = await PaymentModel.find({
      refType: "membership",
      businessId: business._id,
      paidAt: {
        $gte: new Date(`${from}T00:00:00+05:30`),
        $lte: new Date(`${to}T23:59:59+05:30`),
      },
    }).lean();
    const membershipsOnline = membershipPayments.reduce((sum, x) => sum + venueShareOf(x), 0);
    advanceOnline += membershipsOnline;
    refunds += membershipPayments.reduce((sum, x) => sum + refundedOf(x), 0);
    fees += membershipPayments.reduce((sum, x) => sum + platformShareOf(x), 0);
    transferred += membershipPayments.reduce((sum, x) => sum + transferredOf(x), 0);
    const paidOut = transferred + payouts.reduce((sum, p) => sum + p.amountPaise, 0);
    return {
      businessId,
      from,
      to,
      bookings: bookings.length,
      bookedValuePaise: bookedValue,
      advanceOnlinePaise: advanceOnline,
      membershipsOnlinePaise: membershipsOnline,
      balanceCollectedPaise: balanceCollected,
      refundsPaise: refunds,
      platformFeesPaise: fees,
      paidOutPaise: paidOut,
      payoutDuePaise: Math.max(0, advanceOnline - paidOut),
      rows,
    };
  }

  /** All-time payout position of every business that has taken online payments. */
  async function adminReport(): Promise<AdminPayoutRow[]> {
    const payments = await PaymentModel.find({
      status: { $in: ["paid", "partially_refunded", "refunded"] },
    }).lean();
    const payouts = await PayoutModel.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $group: { _id: "$businessId", total: { $sum: "$amountPaise" } } },
    ]);
    const ids = [
      ...new Set([
        ...payments.map((p) => String(p.businessId)),
        ...payouts.map((p) => String(p._id)),
      ]),
    ];
    const businesses = await BusinessModel.find({
      _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    }).lean();
    const manual = new Map(payouts.map((p) => [String(p._id), p.total]));
    return businesses
      .map((b) => {
        const mine = payments.filter((p) => String(p.businessId) === String(b._id));
        const advance = mine.reduce((sum, p) => sum + venueShareOf(p), 0);
        const paidOut =
          mine.reduce((sum, p) => sum + transferredOf(p), 0) + (manual.get(String(b._id)) ?? 0);
        return {
          businessId: String(b._id),
          businessName: b.name,
          payout: toPayoutInfo(b, mode),
          advanceOnlinePaise: advance,
          paidOutPaise: paidOut,
          payoutDuePaise: Math.max(0, advance - paidOut),
        };
      })
      .sort((a, b) => b.payoutDuePaise - a.payoutDuePaise);
  }

  async function record(
    admin: AuthUser,
    input: { businessId: string; amountPaise: number; reference: string },
  ) {
    const business = await BusinessModel.findById(input.businessId).lean();
    if (!business) throw new HttpError(404, "NOT_FOUND", "Business not found");
    const payout = await PayoutModel.create({
      businessId: business._id,
      amountPaise: input.amountPaise,
      reference: input.reference,
      recordedBy: new Types.ObjectId(admin.id),
    });
    await audit(admin.id, "payout.record", "business", input.businessId, {
      amountPaise: input.amountPaise,
      reference: input.reference,
    });
    return payout;
  }

  return { setup, transferForPayment, reverseForRefund, earnings, adminReport, record };
}

export type PayoutService = ReturnType<typeof createPayoutService>;
