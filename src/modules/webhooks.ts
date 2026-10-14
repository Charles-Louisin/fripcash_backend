import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ah } from "../utils/async-handler.js";
import { logger } from "../utils/logger.js";
import { assertCinetPayWebhookKey } from "../services/cinetpay.js";
import { handleCinetPayNotify } from "../services/payments.js";

export const cinetpayWebhookRouter = Router();

const notifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

cinetpayWebhookRouter.use(notifyLimiter);

cinetpayWebhookRouter.get(
  "/:key",
  ah(async (req, res) => {
    assertCinetPayWebhookKey(String(req.params.key || ""));
    res.status(200).end();
  })
);

cinetpayWebhookRouter.post(
  "/:key",
  ah(async (req, res) => {
    assertCinetPayWebhookKey(String(req.params.key || ""));
    res.status(200).json({ ok: true });
    const body = req.body || {};
    void handleCinetPayNotify({
      notify_token: body.notify_token,
      merchant_transaction_id: body.merchant_transaction_id,
      transaction_id: body.transaction_id,
    }).catch((err) => {
      logger.error({ err }, "CinetPay notify processing failed");
    });
  })
);
