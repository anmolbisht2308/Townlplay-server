import type { ErrorCode } from "@townplay/shared";

/** Throw from handlers/services; the error middleware turns it into `{ error: { code, message, details? } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | (string & {}),
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const unauthenticated = () => new HttpError(401, "UNAUTHENTICATED", "Sign in required");
export const forbidden = (message = "Not allowed") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found`);
