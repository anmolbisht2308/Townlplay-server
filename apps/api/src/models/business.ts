import { BUSINESS_STATUSES, BUSINESS_TYPES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerUserIds: { type: [Schema.Types.ObjectId], required: true, index: true },
    type: { type: String, enum: BUSINESS_TYPES, required: true },
    contactPhone: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    kyc: {
      legalName: { type: String, required: true },
      pan: { type: String },
      gstin: { type: String },
    },
    payout: {
      status: {
        type: String,
        enum: ["not_started", "pending", "active", "failed"],
        default: "not_started",
      },
      razorpayLinkedAccountId: { type: String },
      accountHolderName: { type: String },
      /** AES-GCM sealed with AUTH_SECRET (lib/crypto.ts); never sent to clients. */
      accountNumberSealed: { type: String },
      accountLast4: { type: String },
      ifsc: { type: String },
    },
    status: { type: String, enum: BUSINESS_STATUSES, default: "draft", index: true },
    reviewNote: { type: String },
  },
  { collection: "businesses", timestamps: true, versionKey: false },
);

export type BusinessRaw = InferSchemaType<typeof businessSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const BusinessModel = model("Business", businessSchema);
export type BusinessDoc = InstanceType<typeof BusinessModel>;
