import { TICKET_ORDER_STATUSES } from "@townplay/shared";
import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

const ticketOrderSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    eventId: { type: Schema.Types.ObjectId, required: true, index: true },
    businessId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    buyer: {
      type: new Schema(
        { name: { type: String, required: true }, phone: { type: String, required: true } },
        { _id: false },
      ),
      required: true,
    },
    items: {
      type: [
        new Schema(
          {
            tierId: { type: Schema.Types.ObjectId, required: true },
            tierName: { type: String, required: true },
            qty: { type: Number, required: true },
            pricePaise: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
    totalPaise: { type: Number, required: true },
    convenienceFeePaise: { type: Number, required: true },
    status: { type: String, enum: TICKET_ORDER_STATUSES, required: true },
    holdExpiresAt: { type: Date },
    paidAt: { type: Date },
    refundPaise: { type: Number, default: 0 },
    reminderSentAt: { type: Date },
  },
  { collection: "ticketOrders", timestamps: true, versionKey: false },
);
ticketOrderSchema.index({ status: 1, holdExpiresAt: 1 });

export type TicketOrderRaw = InferSchemaType<typeof ticketOrderSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const TicketOrderModel = model("TicketOrder", ticketOrderSchema);
export type TicketOrderDoc = InstanceType<typeof TicketOrderModel>;
