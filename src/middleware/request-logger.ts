import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

const SECRET_KEYS = new Set([
  "password",
  "newPassword",
  "confirmPassword",
  "passwordHash",
]);

function safeBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key) ? "***" : value;
  }
  return out;
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    const path = req.originalUrl || req.url;
    if (path.startsWith("/uploads") || path === "/api/v1/health") return;
    const ok = res.statusCode < 400;
    const payload = {
      result: ok ? "OK" : "FAIL",
      method: req.method,
      path,
      status: res.statusCode,
      ms,
      ...(ok ? {} : { body: safeBody(req.body) }),
    };
    const line = `${ok ? "OK  " : "FAIL"} ${req.method} ${path} → ${res.statusCode} (${ms}ms)`;
    console.log(`[API] ${line}`);
    if (ok) logger.info(payload, line);
    else logger.warn(payload, line);
  });
  next();
}
