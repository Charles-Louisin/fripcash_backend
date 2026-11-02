/**
 * Routes publiques du paiement Chap Chap Pay :
 *  - webhooks signés (paiement client et reversements PUSH) — corps BRUT requis pour le HMAC ;
 *  - page de retour après la page de paiement hébergée ;
 *  - configuration affichée par l'app.
 * Un webhook valide ne fait qu'enregistrer l'événement et planifier une vérification par l'API.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { Payment } from "../models/commerce.js";
import { PaymentWebhookEvent, PayoutWebhookEvent } from "../models/finance.js";
import { ah } from "../utils/async-handler.js";
import { sid } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { verifyCcpWebhook } from "../services/chapchappay.js";
import { auditFinance, enqueue } from "../services/finance/core.js";
import { schedulePayoutVerificationFromWebhook } from "../services/finance/payout-service.js";

const webhookLimiter = rateLimit({ windowMs: 60_000, max: 300 });

function readSignedBody(req: Request) {
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
  const valid = verifyCcpWebhook(raw, req.header("ccp-hmac-signature"), req.header("ccp-api-key"));
  let data: any = null;
  if (valid) {
    try {
      data = JSON.parse(raw.toString("utf8"));
      // Ancien format notify_url : corps = chaîne JSON encodée.
      if (typeof data === "string") data = JSON.parse(data);
    } catch {
      data = null;
    }
  }
  return { valid, data };
}

async function rejectWebhook(req: Request, res: Response, channel: string) {
  await auditFinance({
    actorType: "provider",
    action: `${channel}.webhook_rejected`,
    severity: "warning",
    ip: req.ip,
    meta: { hasSignature: Boolean(req.header("ccp-hmac-signature")) },
  }).catch(() => null);
  res.status(401).json({ error: "invalid_signature" });
}

async function storeEvent(model: typeof PaymentWebhookEvent, doc: Record<string, unknown>) {
  const res = await model.updateOne(
    { eventKey: doc.eventKey },
    { $setOnInsert: { ...doc, receivedAt: new Date() } },
    { upsert: true }
  );
  if (!res.upsertedCount) await model.updateOne({ eventKey: doc.eventKey }, { $inc: { duplicates: 1 } });
  return res.upsertedCount > 0;
}

export const paymentsPublicRouter = Router();

paymentsPublicRouter.get("/config", (_req, res) => {
  res.json({
    provider: "chapchappay",
    minPaymentGnf: env.chapchapMinPaymentGnf,
    hostedPage: true,
    methods: ["OM_GN", "MTN_GN", "CHAPCHAPPAY"],
  });
});

/** Retour depuis la page Chap Chap Pay : renvoie vers l'app. N'atteste JAMAIS le paiement. */
paymentsPublicRouter.get(
  "/return/:ref",
  ah(async (req, res) => {
    const ref = String(req.params.ref || "").slice(0, 64);
    const payment = /^[A-Za-z0-9_-]{4,64}$/.test(ref)
      ? await Payment.findOne({ merchantTransactionId: ref }, "appReturnUrl merchantTransactionId").lean()
      : null;
    const base = (payment?.appReturnUrl || "fripcash://paiement").replace(/\/$/, "");
    const target = `${base}/${encodeURIComponent(payment?.merchantTransactionId || ref)}${req.query.cancel ? "?cancel=1" : ""}`;
    res.redirect(302, target);
  })
);

paymentsPublicRouter.post(
  "/webhook/:provider",
  webhookLimiter,
  ah(async (req, res) => {
    if (req.params.provider !== "chapchappay") {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    const { valid, data } = readSignedBody(req);
    if (!valid) return rejectWebhook(req, res, "payment");
    if (!data) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    const operationId = String(data.operation_id || "");
    const orderId = String(data.order_id || "");
    const statusCode = String(data.status?.code || data.status || "");
    const eventKey = `chapchappay:ecom:${operationId || orderId}:${statusCode}`;
    const fresh = await storeEvent(PaymentWebhookEvent, {
      provider: "chapchappay",
      eventKey,
      reference: operationId,
      orderId,
      statusCode,
      signatureValid: true,
      payload: data,
    });
    const payment =
      (orderId && (await Payment.findOne({ merchantTransactionId: orderId }, "_id").lean())) ||
      (operationId && (await Payment.findOne({ providerOperationId: operationId }, "_id").lean()));
    if (payment) {
      await enqueue("payment.verify", { paymentId: sid(payment._id) }, `payment.verify:${sid(payment._id)}:wh:${eventKey}`);
    } else {
      logger.warn({ orderId, operationId }, "ChapChapPay webhook for unknown payment");
    }
    await PaymentWebhookEvent.updateOne(
      { eventKey },
      { $set: { processedAt: new Date(), outcome: payment ? (fresh ? "verification_scheduled" : "duplicate") : "unknown_payment" } }
    );
    res.status(200).json({ received: true });
  })
);

export const payoutsPublicRouter = Router();

payoutsPublicRouter.post(
  "/webhook/:provider",
  webhookLimiter,
  ah(async (req, res) => {
    if (req.params.provider !== "chapchappay") {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }
    const { valid, data } = readSignedBody(req);
    if (!valid) return rejectWebhook(req, res, "payout");
    if (!data) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    const requestId = String(data.request_id || "");
    const orderId = String(data.request_data?.order_id || data.order_id || "");
    const statusCode = String(data.status?.code || data.status || "");
    const eventKey = `chapchappay:push:${requestId || orderId}:${statusCode}`;
    await storeEvent(PayoutWebhookEvent, {
      provider: "chapchappay",
      eventKey,
      reference: requestId,
      orderId,
      statusCode,
      signatureValid: true,
      payload: data,
    });
    const attempt = await schedulePayoutVerificationFromWebhook(requestId, orderId, eventKey);
    await PayoutWebhookEvent.updateOne(
      { eventKey },
      { $set: { processedAt: new Date(), outcome: attempt ? "verification_scheduled" : "unknown_payout" } }
    );
    res.status(200).json({ received: true });
  })
);
