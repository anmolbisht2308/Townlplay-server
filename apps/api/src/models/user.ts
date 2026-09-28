import { LANGS, ROLES } from "@townplay/shared";
import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * The `users` collection is written by better-auth (see auth/auth.ts). This model is for our own
 * reads/updates (profile, roles, seed); field names must match better-auth's.
 */
const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerified: { type: Boolean, default: false },
    image: { type: String },
    phone: { type: String },
    roles: { type: [{ type: String, enum: ROLES }], default: ["player"] },
    lang: { type: String, enum: LANGS, default: "en" },
    cityId: { type: String },
    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { collection: "users", versionKey: false },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
