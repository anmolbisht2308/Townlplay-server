import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { connectMongo, mongoDb } from "./db.js";
import { parseEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { startJobs } from "./jobs.js";
import { attachRealtime } from "./realtime.js";
import { initSentry } from "./sentry.js";
import { createServices } from "./services/index.js";
import { FakeGateway, RazorpayGateway } from "./services/paymentGateway.js";
import { RecordingPushSender, WebPushSender } from "./services/push.js";
import { parseCloudinaryUrl } from "./services/uploads.js";
import { BrevoEmailSender, LogEmailSender } from "./services/email.js";

const env = parseEnv(process.env);
initSentry(env);
const logger = createLogger(env);

await connectMongo(env.MONGODB_URI);
const email = env.BREVO_API_KEY
  ? new BrevoEmailSender(env.BREVO_API_KEY, env.EMAIL_FROM)
  : new LogEmailSender(logger);
const auth = createAuth({
  env,
  db: mongoDb(),
  client: mongoose.connection.getClient(),
  email,
  logger,
});

const gateway =
  env.PAYMENTS_PROVIDER === "razorpay"
    ? new RazorpayGateway(
        env.RAZORPAY_KEY_ID ?? "",
        env.RAZORPAY_KEY_SECRET ?? "",
        env.RAZORPAY_WEBHOOK_SECRET ?? "",
      )
    : new FakeGateway(undefined, env.RAZORPAY_WEBHOOK_SECRET);
const push =
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? new WebPushSender(
        {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT,
        },
        logger,
      )
    : new RecordingPushSender();
const services = createServices({
  env,
  logger,
  email,
  push,
  gateway,
  ...(env.CLOUDINARY_URL ? { cloudinary: parseCloudinaryUrl(env.CLOUDINARY_URL) } : {}),
});
const app = createApp({ env, logger, auth, services });
const server = createServer(app);
attachRealtime(server, { auth, env, logger, events: services.events });
const agenda = await startJobs(mongoDb(), services, logger);
server.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      email: email.name,
      payments: gateway.provider,
      push: push.name,
      payouts: env.PAYOUTS_MODE,
    },
    "api listening",
  );
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void agenda
      .stop()
      .then(() => mongoose.disconnect())
      .then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
