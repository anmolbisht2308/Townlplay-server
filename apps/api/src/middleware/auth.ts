import { roleSchema, langSchema, type Me, type Role } from "@townplay/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler } from "express";
import type { Auth } from "../auth/auth.js";
import { forbidden, unauthenticated } from "../lib/httpError.js";

export type AuthUser = Me;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express augments Request via this namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

type SessionUser = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>["user"];

export function toAuthUser(u: SessionUser): AuthUser {
  const roles = (u.roles ?? []).filter((r): r is Role => roleSchema.safeParse(r).success);
  const lang = langSchema.safeParse(u.lang);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image ?? null,
    phone: u.phone ?? null,
    roles: roles.length > 0 ? roles : ["player"],
    lang: lang.success ? lang.data : "en",
    cityId: u.cityId ?? null,
  };
}

/** Resolves the better-auth session cookie into `req.user`; 401 without a valid session. */
export function requireAuth(auth: Auth): RequestHandler {
  return async (req, _res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw unauthenticated();
    req.user = toAuthUser(session.user);
    next();
  };
}

/** Use after requireAuth. Passes when the user has any of the given roles. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) throw unauthenticated();
    if (!roles.some((r) => user.roles.includes(r))) throw forbidden();
    next();
  };
}
