import type { Logger } from "pino";
import webpush from "web-push";
import { PushSubscriptionModel } from "../models/pushSubscription.js";

export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

export interface PushSender {
  readonly name: string;
  send(userIds: string[], message: PushMessage): Promise<void>;
}

/** Web Push (VAPID) to every saved subscription of the users; dead subscriptions are removed. */
export class WebPushSender implements PushSender {
  readonly name = "webpush";

  constructor(
    vapid: { publicKey: string; privateKey: string; subject: string },
    private readonly logger: Logger,
  ) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(userIds: string[], message: PushMessage): Promise<void> {
    const subs = await PushSubscriptionModel.find({ userId: { $in: userIds } }).lean();
    await Promise.all(
      subs.map(async (s) => {
        if (!s.keys) return;
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
            JSON.stringify(message),
            { TTL: 3600 },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410)
            await PushSubscriptionModel.deleteOne({ _id: s._id });
          else this.logger.warn({ err, endpoint: s.endpoint }, "web push failed");
        }
      }),
    );
  }
}

/** Dev/test: records pushes instead of sending them. */
export class RecordingPushSender implements PushSender {
  readonly name = "recording";
  readonly sent: { userIds: string[]; message: PushMessage }[] = [];
  send(userIds: string[], message: PushMessage) {
    this.sent.push({ userIds, message });
    return Promise.resolve();
  }
}
