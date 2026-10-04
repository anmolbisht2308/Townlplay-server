/** Idempotent seed: launch cities + the SEED_ADMIN_EMAIL admin user. */
import { SEED_CITIES } from "@townplay/shared";
import mongoose from "mongoose";
import { pino } from "pino";
import { connectMongo } from "../db.js";
import { isMain } from "../lib/isMain.js";
import { parseEnv } from "../env.js";
import { CityModel } from "../models/city.js";
import { UserModel } from "../models/user.js";

export async function seed(adminEmail: string | undefined): Promise<void> {
  for (const city of SEED_CITIES) {
    await CityModel.updateOne(
      { slug: city.slug },
      { $setOnInsert: { ...city, isActive: true } },
      { upsert: true },
    );
  }
  if (adminEmail) {
    const email = adminEmail.toLowerCase();
    await UserModel.updateOne(
      { email },
      {
        $setOnInsert: {
          name: "Admin",
          email,
          emailVerified: true,
          lang: "en",
          createdAt: new Date(),
        },
        $addToSet: { roles: { $each: ["player", "admin"] } },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    );
  }
}

if (isMain(import.meta.url)) {
  const env = parseEnv(process.env);
  const log = pino();
  await connectMongo(env.MONGODB_URI);
  await CityModel.syncIndexes();
  await UserModel.syncIndexes();
  await seed(env.SEED_ADMIN_EMAIL);
  log.info({ admin: env.SEED_ADMIN_EMAIL ?? null }, "seed complete");
  await mongoose.disconnect();
}
