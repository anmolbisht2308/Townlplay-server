import type { RequestHandler } from "express";
import type { z } from "zod";

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validates body / query / params with Zod schemas from @townplay/shared. Parsed values replace
 * `req.body` and `req.params`; the parsed query is on `res.locals.query` (Express 5 `req.query` is
 * read-only). A ZodError goes to the error middleware → 400 VALIDATION_FAILED.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
    if (schemas.query) res.locals.query = schemas.query.parse(req.query);
    next();
  };
}

/** A validated route param as a string (Express 5 types params as `string | string[]`). */
export function param(
  req: { params: Record<string, string | string[] | undefined> },
  name: string,
) {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`missing route param ${name}`);
  return value;
}
