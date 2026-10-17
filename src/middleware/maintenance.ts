import type { NextFunction, Request, Response } from "express";
import { getSettings } from "../services/notify.js";
import { HttpError } from "../utils/http-error.js";
import { verifyToken } from "../utils/jwt.js";

const OPEN_PREFIXES = ["/api/v1/auth", "/api/v1/admin", "/api/v1/cpn", "/api/v1/payments", "/api/v1/health"];
const CACHE_MS = 15_000;

let cached: { on: boolean; at: number } | null = null;

async function maintenanceOn() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.on;
  const settings = await getSettings();
  cached = { on: !!settings.maintenanceMode, at: Date.now() };
  return cached.on;
}

export function resetMaintenanceCache() {
  cached = null;
}

function isAdminRequest(req: Request) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return false;
  try {
    return verifyToken(token).aud === "ADMIN";
  } catch {
    return false;
  }
}

/** En maintenance, les lectures restent possibles mais les écritures hors admin sont refusées. */
export async function maintenanceGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!req.path.startsWith("/api/v1/")) return next();
    if (OPEN_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!(await maintenanceOn()) || isAdminRequest(req)) return next();
    next(
      new HttpError(
        503,
        "MAINTENANCE",
        "FripCash est en maintenance. Réessaie dans quelques minutes."
      )
    );
  } catch (err) {
    next(err);
  }
}
