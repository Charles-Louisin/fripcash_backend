/**
 * Routes publiques du paiement Chap Chap Pay :
 *  - webhooks signés (paiement client et reversements PUSH) — corps BRUT requis pour le HMAC ;
 *  - page de retour après la page de paiement hébergée ;
 *  - configuration affichée par l'app.
 * Un webhook valide ne fait qu'enregistrer l'événement et planifier une vérification par l'API.
 */
import { randomBytes } from "crypto";
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
import { feeSchedule } from "../services/finance/fees.js";

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
    fees: feeSchedule(),
  });
});

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Retour depuis la page Chap Chap Pay : renvoie vers l'app (lien profond) ou, à défaut, vers le
 * site FripCash. N'atteste JAMAIS le paiement : l'écran de l'app le vérifie auprès du serveur.
 * Page HTML plutôt qu'une simple redirection : certains navigateurs Android refusent d'ouvrir une
 * app sans geste de l'utilisateur, le bouton sert alors de secours.
 */
paymentsPublicRouter.get(
  "/return/:ref",
  ah(async (req, res) => {
    const ref = String(req.params.ref || "").slice(0, 64);
    const payment = /^[A-Za-z0-9_-]{4,64}$/.test(ref)
      ? await Payment.findOne({ merchantTransactionId: ref }, "appReturnUrl merchantTransactionId").lean()
      : null;
    const reference = encodeURIComponent(payment?.merchantTransactionId || ref);
    const query = req.query.cancel ? "?cancel=1" : "";
    const appTarget = payment?.appReturnUrl ? `${payment.appReturnUrl.replace(/\/$/, "")}/${reference}${query}` : "";
    const webTarget = `${env.appWebUrl}/paiement/${reference}${query}`;
    const target = appTarget || webTarget;
    const title = req.query.cancel ? "Paiement interrompu" : "Paiement terminé";
    const nonce = randomBytes(12).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`
    );
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">
<title>${title} · FripCash</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FBF5F1;font-family:system-ui,-apple-system,sans-serif;color:#2B1D16}
main{max-width:360px;padding:32px 24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#7A6A61;line-height:1.5;margin:0 0 24px}
a{display:block;padding:14px 20px;border-radius:999px;background:#C0603C;color:#fff;text-decoration:none;font-weight:600;margin-bottom:12px}
a.alt{background:transparent;color:#C0603C;border:1px solid #C0603C}</style></head>
<body><main><h1>${title}</h1><p>Retour à FripCash pour voir la confirmation de ta commande…</p>
<a href="${escapeHtml(target)}">Retourner dans FripCash</a>${appTarget ? `<a class="alt" href="${escapeHtml(webTarget)}">Ouvrir sur le site</a>` : ""}</main>
<script nonce="${nonce}">location.replace(${JSON.stringify(target)});</script></body></html>`);
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
