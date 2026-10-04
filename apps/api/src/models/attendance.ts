import type { Types } from "mongoose";
import { Schema, model, type InferSchemaType } from "mongoose";

/** Who attended one session of a batch. */
const attendanceSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    present: { type: [Schema.Types.ObjectId], default: [] },
    markedBy: { type: Schema.Types.ObjectId },
  },
  { collection: "attendance", timestamps: true, versionKey: false },
);
attendanceSchema.index({ batchId: 1, date: 1 }, { unique: true });

export type AttendanceRaw = InferSchemaType<typeof attendanceSchema> & { _id: Types.ObjectId };
export const AttendanceModel = model("Attendance", attendanceSchema);
