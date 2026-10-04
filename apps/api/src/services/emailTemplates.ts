import { formatPaise, type Booking } from "@townplay/shared";
import type { EmailMessage } from "./email.js";

/**
 * Transactional emails as plain text + simple HTML (bilingual body). Kept as functions rather
 * than React Email so the api does not pull in React; swap in later if designs need it.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function render(
  to: string,
  subject: string,
  lines: string[],
  hindi: string[],
  link?: { url: string; label: string },
): EmailMessage {
  const text = [...lines, "", ...hindi, ...(link ? ["", `${link.label}: ${link.url}`] : [])].join(
    "\n",
  );
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("\n")}
${link ? `<p><a href="${esc(link.url)}" style="background:#15803d;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(link.label)}</a></p>` : ""}
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
${hindi.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("\n")}
</div>`;
  return { to, subject, text, html };
}

const when = (b: Booking) => `${b.date}, ${b.startTime}–${b.endTime}`;

export function bookingConfirmedEmail(to: string, b: Booking, webOrigin: string): EmailMessage {
  return render(
    to,
    `Booking confirmed: ${b.venue.name}, ${when(b)} (${b.code})`,
    [
      `Your booking at ${b.venue.name} (${b.resource.name}) is confirmed.`,
      `When: ${when(b)}. Booking code: ${b.code}.`,
      `Paid online: ${formatPaise(b.amount.advancePaise + b.amount.convenienceFeePaise)}. Pay at the venue: ${formatPaise(b.amount.balancePaise)}.`,
      `Venue phone: +91 ${b.venue.contactPhone}.`,
    ],
    [`${b.venue.name} पर आपकी बुकिंग पक्की है।`, `समय: ${when(b)}। बुकिंग कोड: ${b.code}।`],
    { url: `${webOrigin}/bookings/${b.id}`, label: "View booking" },
  );
}

export function bookingCancelledEmail(to: string, b: Booking, webOrigin: string): EmailMessage {
  const refund = b.cancellation?.refundPaise ?? 0;
  const byVenue = b.cancellation?.by !== "player";
  return render(
    to,
    `Booking cancelled: ${b.venue.name}, ${when(b)} (${b.code})`,
    [
      byVenue
        ? `Sorry, your booking at ${b.venue.name} for ${when(b)} was cancelled.`
        : `You cancelled your booking at ${b.venue.name} for ${when(b)}.`,
      ...(b.cancellation?.reason ? [`Reason: ${b.cancellation.reason}`] : []),
      refund > 0
        ? `A refund of ${formatPaise(refund)} has been started. It usually reaches you in 5–7 working days.`
        : "No refund is due for this cancellation.",
    ],
    [
      `${b.venue.name} की बुकिंग (${when(b)}) रद्द हो गई है।`,
      ...(refund > 0 ? [`${formatPaise(refund)} की वापसी शुरू हो गई है।`] : []),
    ],
    { url: `${webOrigin}/bookings/${b.id}`, label: "View booking" },
  );
}

export function refundProcessedEmail(
  to: string,
  b: Booking,
  amountPaise: number,
  webOrigin: string,
): EmailMessage {
  return render(
    to,
    `Refund processed: ${formatPaise(amountPaise)} (${b.code})`,
    [
      `Your refund of ${formatPaise(amountPaise)} for booking ${b.code} at ${b.venue.name} has been processed.`,
    ],
    [`बुकिंग ${b.code} के लिए ${formatPaise(amountPaise)} की वापसी हो गई है।`],
    { url: `${webOrigin}/bookings/${b.id}`, label: "View booking" },
  );
}

export function ownerNewBookingEmail(to: string, b: Booking, webOrigin: string): EmailMessage {
  return render(
    to,
    `New booking: ${b.resource.name}, ${when(b)}`,
    [
      `New online booking at ${b.venue.name}.`,
      `${b.resource.name}, ${when(b)}. Code ${b.code}.`,
      ...(b.customer ? [`Customer: ${b.customer.name}, +91 ${b.customer.phone}.`] : []),
      `Advance paid: ${formatPaise(b.amount.advancePaise)}. Collect at the venue: ${formatPaise(b.amount.balancePaise)}.`,
    ],
    [`${b.venue.name} पर नई बुकिंग: ${b.resource.name}, ${when(b)}।`],
    { url: `${webOrigin}/owner/venues/${b.venue.id}/calendar`, label: "Open calendar" },
  );
}

export function ownerCancellationEmail(to: string, b: Booking, webOrigin: string): EmailMessage {
  return render(
    to,
    `Booking cancelled: ${b.resource.name}, ${when(b)}`,
    [
      `Booking ${b.code} (${b.resource.name}, ${when(b)}) at ${b.venue.name} was cancelled. The slot is free again.`,
    ],
    [`बुकिंग ${b.code} (${when(b)}) रद्द हो गई। स्लॉट फिर से खाली है।`],
    { url: `${webOrigin}/owner/venues/${b.venue.id}/calendar`, label: "Open calendar" },
  );
}

export interface EventEmailInfo {
  orderId: string;
  code: string;
  title: string;
  startsAt: Date;
  address: string;
  tickets: number;
  totalPaise: number;
}

const istWhen = (d: Date) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);

export function ticketConfirmedEmail(
  to: string,
  e: EventEmailInfo,
  webOrigin: string,
): EmailMessage {
  return render(
    to,
    `Your tickets: ${e.title} (${e.code})`,
    [
      `You have ${e.tickets} ticket${e.tickets === 1 ? "" : "s"} for ${e.title}.`,
      `When: ${istWhen(e.startsAt)}. Where: ${e.address}.`,
      e.totalPaise > 0 ? `Paid: ${formatPaise(e.totalPaise)}.` : "This is a free RSVP.",
      "Show the QR code on your phone at the entrance.",
    ],
    [`${e.title} के लिए आपके ${e.tickets} टिकट तैयार हैं। प्रवेश पर QR कोड दिखाएँ।`],
    { url: `${webOrigin}/tickets/${e.orderId}`, label: "Open tickets" },
  );
}

export function eventReminderEmail(to: string, e: EventEmailInfo, webOrigin: string): EmailMessage {
  return render(
    to,
    `Tomorrow: ${e.title}`,
    [
      `Reminder: ${e.title} is tomorrow, ${istWhen(e.startsAt)}, at ${e.address}.`,
      "Keep your QR tickets ready.",
    ],
    [`याद दिलाना: ${e.title} कल ${istWhen(e.startsAt)} पर है।`],
    { url: `${webOrigin}/tickets/${e.orderId}`, label: "Open tickets" },
  );
}

export function eventCancelledEmail(
  to: string,
  e: EventEmailInfo & { refundPaise: number; reason: string },
  webOrigin: string,
): EmailMessage {
  return render(
    to,
    `Cancelled: ${e.title}`,
    [
      `Sorry, ${e.title} (${istWhen(e.startsAt)}) has been cancelled by the organiser.`,
      ...(e.reason ? [`Reason: ${e.reason}`] : []),
      e.refundPaise > 0
        ? `A full refund of ${formatPaise(e.refundPaise)} has been started. It usually reaches you in 5–7 working days.`
        : "Your RSVP has been cancelled.",
    ],
    [
      `${e.title} रद्द हो गया है।${e.refundPaise > 0 ? ` ${formatPaise(e.refundPaise)} की पूरी वापसी शुरू हो गई है।` : ""}`,
    ],
    { url: `${webOrigin}/tickets/${e.orderId}`, label: "View order" },
  );
}
