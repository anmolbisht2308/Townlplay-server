import { Types } from "mongoose";
import { AuditLogModel } from "../models/auditLog.js";

/** Records an owner/admin mutation on businesses, venues, resources (and later bookings, payments). */
export async function audit(
  actorUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await AuditLogModel.create({
    actorUserId: new Types.ObjectId(actorUserId),
    action,
    entityType,
    entityId,
    ...(meta ? { meta } : {}),
  });
}
