import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../utils/http-error.js";
import { logger } from "../utils/logger.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const locale = req.header("x-locale") === "EN" ? "EN" : "FR";

  if (err instanceof ZodError) {
    logger.warn(
      { path: req.originalUrl, method: req.method, issues: err.issues },
      `FAIL ${req.method} ${req.originalUrl} → 400 VALIDATION_ERROR`
    );
    return res.status(400).json({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: err.issues[0]?.message || "Données invalides",
      locale,
    });
  }

  if (err instanceof HttpError) {
    logger.warn(
      { path: req.originalUrl, method: req.method, code: err.code },
      `FAIL ${req.method} ${req.originalUrl} → ${err.statusCode} ${err.code}`
    );
    return res.status(err.statusCode).json({
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      locale,
    });
  }

  const name = err?.name as string | undefined;
  if (name === "JsonWebTokenError" || name === "TokenExpiredError" || name === "NotBeforeError") {
    logger.warn(
      { path: req.originalUrl, method: req.method, code: "UNAUTHORIZED" },
      `FAIL ${req.method} ${req.originalUrl} → 401 UNAUTHORIZED`
    );
    return res.status(401).json({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Session invalide",
      locale,
    });
  }

  logger.error({ err, path: req.originalUrl, method: req.method }, "Unhandled error");
  return res.status(500).json({
    statusCode: 500,
    code: "INTERNAL",
    message: "Erreur serveur",
    locale,
  });
};
