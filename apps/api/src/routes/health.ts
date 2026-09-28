import type { HealthResponse } from "@townplay/shared";
import { Router } from "express";
import mongoose from "mongoose";

export function healthRouter(version: string): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      version,
      db: mongoose.connection.readyState === mongoose.ConnectionStates.connected ? "up" : "down",
    };
    res.json(body);
  });
  return router;
}
