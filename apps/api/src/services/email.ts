import type { Logger } from "pino";
import { Resend } from "resend";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Every provider sits behind this interface; tests record, dev logs, production uses Resend. */
export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  readonly name = "resend";
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    if (error) throw new Error(`Resend: ${error.message}`);
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
