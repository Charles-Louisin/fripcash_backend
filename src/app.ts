import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import { createRouteHandler } from "uploadthing/express";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errors.js";
import { requestLogger } from "./middleware/request-logger.js";
import { authRouter } from "./modules/auth.js";
import { meRouter, orgRouter } from "./modules/me.js";
import { catalogRouter } from "./modules/catalog.js";
import { listingsRouter, reviewsRouter } from "./modules/listings.js";
import { cartRouter, checkoutRouter } from "./modules/cart.js";
import { invoicesRouter, ordersRouter } from "./modules/orders.js";
import { walletRouter } from "./modules/wallet.js";
import {
  conversationsRouter,
  favoritesRouter,
  notificationsRouter,
  offersRouter,
  reportsRouter,
} from "./modules/social.js";
import { courierRouter } from "./modules/courier.js";
import { adminRouter, authAdminRouter } from "./modules/admin.js";
import { disputesRouter } from "./modules/disputes.js";
import { uploadRouter } from "./uploadthing/router.js";
import { mediaRouter } from "./modules/media.js";
import { requireAuth, type AuthedRequest } from "./middleware/auth.js";
import { toMe } from "./serializers.js";
import path from "path";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        const allowed = env.corsOrigin.split(",").map((s) => s.trim());
        if (allowed.includes(origin)) return cb(null, true);
        if (env.nodeEnv !== "production") {
          try {
            const host = new URL(origin).hostname;
            if (
              host === "localhost" ||
              host === "127.0.0.1" ||
              /^192\.168\.\d+\.\d+$/.test(host) ||
              /^10\.\d+\.\d+\.\d+$/.test(host)
            ) {
              return cb(null, true);
            }
          } catch {
            /* ignore */
          }
        }
        cb(new Error(`CORS blocked: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: "16mb" }));
  app.use(requestLogger);

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 80 });
  app.use("/api/v1/auth/phone-number", authLimiter);
  app.use("/api/v1/auth/sign-in", authLimiter);
  app.use("/api/v1/auth/sign-up", authLimiter);
  app.use("/api/v1/auth/admin/login", authLimiter);
  app.use("/api/v1/auth/request-password-reset", authLimiter);
  app.use("/api/v1/auth/reset-password", authLimiter);
  app.use("/api/v1/auth/send-verification-email", authLimiter);
  app.use("/api/v1/auth/verify-email-code", authLimiter);

  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
  app.get("/api/v1/health/ready", (_req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ ready });
  });

  app.use("/api/v1/auth/admin", authAdminRouter);
  app.use("/api/v1/auth", authRouter);
  app.get("/api/v1/me", requireAuth, (req, res) => {
    res.json(toMe((req as AuthedRequest).userDoc!));
  });
  app.use("/api/v1/me", meRouter);
  app.use("/api/v1/organizations", orgRouter);
  app.use("/api/v1/catalog", catalogRouter);
  app.use("/api/v1/listings", listingsRouter);
  app.use("/api/v1/sellers", reviewsRouter);
  app.use("/api/v1/cart", cartRouter);
  app.use("/api/v1/checkout", checkoutRouter);
  app.use("/api/v1/orders", ordersRouter);
  app.use("/api/v1/invoices", invoicesRouter);
  app.use("/api/v1/wallet", walletRouter);
  app.use("/api/v1/offers", offersRouter);
  app.use("/api/v1/conversations", conversationsRouter);
  app.use("/api/v1/favorites", favoritesRouter);
  app.use("/api/v1/notifications", notificationsRouter);
  app.use("/api/v1/reports", reportsRouter);
  app.use("/api/v1/disputes", disputesRouter);
  app.use("/api/v1/courier", courierRouter);
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1/media", mediaRouter);
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  if (env.uploadthingToken) {
    app.use(
      "/api/uploadthing",
      createRouteHandler({
        router: uploadRouter,
        config: { token: env.uploadthingToken },
      })
    );
  }

  app.use(errorHandler);
  return app;
}
