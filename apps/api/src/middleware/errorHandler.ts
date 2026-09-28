import * as Sentry from "@sentry/node";
import type { ApiError } from "@townplay/shared";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiError = {
    error: { code: "NOT_FOUND", message: `Not found: ${req.method} ${req.path}` },
  };
  res.status(404).json(body);
};

/** The single error middleware. Always responds `{ error: { code, message, details? } }`. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let status = 500;
  let error: ApiError["error"] = { code: "INTERNAL", message: "Internal server error" };

  if (err instanceof HttpError) {
    status = err.status;
    error = {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  } else if (err instanceof ZodError) {
    status = 400;
    error = { code: "VALIDATION_FAILED", message: "Validation failed", details: err.issues };
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    error = {
      code: "CONFLICT",
      message: "Already exists",
      details: { fields: Object.keys(err.keyValue ?? {}) },
    };
  } else if (isBodyParserError(err)) {
    status = err.status;
    error = {
      code: "VALIDATION_FAILED",
      message: err.type === "entity.too.large" ? "Request body too large" : "Invalid JSON",
    };
  }

  if (status >= 500) {
    req.log.error({ err }, "unhandled error");
    Sentry.captureException(err);
  }
  res.status(status).json({ error } satisfies ApiError);
};

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "status" in err &&
    typeof err.status === "number" &&
    typeof err.type === "string"
  );
}

function isDuplicateKeyError(
  err: unknown,
): err is { code: 11000; keyValue?: Record<string, unknown> } {
  return typeof err === "object" && err !== null && "code" in err && err.code === 11000;
}
