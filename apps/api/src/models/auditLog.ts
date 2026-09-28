import { Schema, model, type InferSchemaType } from "mongoose";

/** Every owner/admin mutation on bookings, payments and listings is recorded here. */
const auditLogSchema = new Schema(
  {
    actorUserId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    meta: { type: Schema.Types.Mixed },
  },
  { collection: "auditLogs", timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model("AuditLog", auditLogSchema);
