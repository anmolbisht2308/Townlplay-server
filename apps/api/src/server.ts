import mongoose from "mongoose";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { connectMongo, mongoDb } from "./db.js";
import { parseEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { initSentry } from "./sentry.js";
import { LogEmailSender, ResendEmailSender } from "./services/email.js";

const env = parseEnv(process.env);
initSentry(env);
const logger = createLogger(env);

await connectMongo(env.MONGODB_URI);
const email = env.RESEND_API_KEY
  ? new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM)
  : new LogEmailSender(logger);
const auth = createAuth({
  env,
  db: mongoDb(),
  client: mongoose.connection.getClient(),
  email,
  logger,
});

const app = createApp({ env, logger, auth });
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, email: email.name }, "api listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void mongoose.disconnect().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
