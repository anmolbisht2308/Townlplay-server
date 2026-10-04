import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/** One admission. `qrToken` is random and unguessable; check-in sets `checkedInAt` once. */
const ticketSchema = new Schema(
  {
    ticketOrderId: { type: Schema.Types.ObjectId, required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, required: true, index: true },
    tierId: { type: Schema.Types.ObjectId, required: true },
    tierName: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    holderName: { type: String, required: true },
    qrToken: { type: String, required: true, unique: true },
    status: { type: String, enum: ["valid", "void"], default: "valid" },
    checkedInAt: { type: Date, default: null },
    checkedInBy: { type: Schema.Types.ObjectId },
  },
  { collection: "tickets", timestamps: true, versionKey: false },
);

export type TicketRaw = InferSchemaType<typeof ticketSchema> & { _id: Types.ObjectId };
export const TicketModel = model("Ticket", ticketSchema);
