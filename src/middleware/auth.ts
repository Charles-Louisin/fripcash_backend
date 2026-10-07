import type { NextFunction, Request, Response } from "express";
import { User } from "../models/user.js";
import { Session } from "../models/auth.js";
import { verifyToken, type AuthAudience } from "../utils/jwt.js";
import { unauthorized, forbidden } from "../utils/http-error.js";

export type AuthedRequest = Request & {
  userId?: string;
  audience?: AuthAudience;
  userDoc?: InstanceType<typeof User>;
};

export async function optionalAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    req.userId = payload.sub;
    req.audience = payload.aud;
  } catch {
    /* ignore invalid optional token */
  }
  next();
}

export async function requireAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw unauthorized();
    const payload = verifyToken(token);
    const session = await Session.findOne({
      token,
      userId: payload.sub,
      expiresAt: { $gt: new Date() },
    });
    if (!session) throw unauthorized("Session invalide");
    const user = await User.findById(payload.sub);
    if (!user || user.banned) throw unauthorized("Session invalide");
    req.userId = payload.sub;
    req.audience = payload.aud;
    req.userDoc = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAudience(...allowed: AuthAudience[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.audience || !allowed.includes(req.audience)) {
      return next(forbidden("FORBIDDEN_AUDIENCE", "Audience non autorisée"));
    }
    next();
  };
}
