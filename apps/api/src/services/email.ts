import type { Logger } from "pino";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Every provider sits behind this interface; tests record, dev logs, production uses Brevo. */
export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** "Townplay <no-reply@x.in>" or "no-reply@x.in" → Brevo's sender object. */
export function parseSender(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return { email: from.trim() };
  return m[1] ? { name: m[1].replace(/^"|"$/g, ""), email: m[2]!.trim() } : { email: m[2]!.trim() };
}

/** Brevo transactional email over its REST API (no SDK). */
export class BrevoEmailSender implements EmailSender {
  readonly name = "brevo";
  private readonly sender: { name?: string; email: string };

  constructor(
    private readonly apiKey: string,
    from: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.sender = parseSender(from);
  }

  async send(message: EmailMessage): Promise<void> {
    const res = await this.fetchFn("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: this.sender,
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        ...(message.html ? { htmlContent: message.html } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Brevo: ${res.status} ${detail.slice(0, 300)}`);
    }
  }
}

/** Dev adapter: writes the email (and so the OTP) to the log instead of sending it. */
export class LogEmailSender implements EmailSender {
  readonly name = "log";
  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      "email (dev)",
    );
    return Promise.resolve();
  }
}
