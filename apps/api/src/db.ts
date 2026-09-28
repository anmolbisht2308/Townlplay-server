import mongoose from "mongoose";

/** Connects Mongoose. The deployment must be a replica set (transactions, see PLAN.md §3). */
export async function connectMongo(uri: string): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
}

export function mongoDb() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  return db;
}
