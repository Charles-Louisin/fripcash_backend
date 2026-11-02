/**
 * Administration financière. Lecture : admins. Actions sensibles (relance, lot, décision sur un
 * statut inconnu, blocage) : ré-authentification par mot de passe (en-tête X-Admin-Password)
 * et journalisation. Aucun endpoint ne permet de modifier un montant ou un numéro destinataire.
 */
import { Router, type NextFunction, type Response } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Order, Payment } from "../models/commerce.js";
import {
  Delivery,
  FinancialAllocation,
  FinancialAuditLog,
  FinancialLedgerEntry,
  ParentOrder,
  Payout,
  PayoutAttempt,
  PayoutBatch,
  PaymentWebhookEvent,
  PayoutWebhookEvent,
  Refund,
} from "../models/finance.js";
import { User } from "../models/user.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { auditFinance } from "../services/finance/core.js";
import {
  executePayoutBatch,
  resolveUnknownPayout,
  retryFailedPayout,
  setPayoutBlocked,
} from "../services/finance/payout-service.js";
import { runReconciliation } from "../services/finance/reconciliation-service.js";
import { confirmDelivery } from "../services/finance/delivery-service.js";

export const adminFinanceRouter = Router();
adminFinanceRouter.use(requireAuth, requireAudience("ADMIN"));

const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, max: 60 });

/** Authentification renforcée pour les opérations qui déclenchent ou débloquent de l'argent. */
async function requireStepUp(req: AuthedRequest, _res: Response, next: NextFunction) {
  try {
    const password = req.header("x-admin-password") || "";
    const user = await User.findById(req.userId).select("passwordHash isAdmin authAudience");
    const ok = Boolean(password && user?.passwordHash && (await bcrypt.compare(password, user.passwordHash)));
    if (!ok) {
      await auditFinance({ actorId: req.userId, actorType: "admin", action: "admin.step_up_failed", severity: "warning", ip: req.ip, meta: { path: req.originalUrl } });
      throw forbidden("STEP_UP_REQUIRED", "Confirme ton mot de passe administrateur pour cette opération.");
    }
    next();
  } catch (err) {
    next(err);
  }
}

const sensitive = [sensitiveLimiter, requireStepUp as any];

function actor(req: unknown) {
  const r = req as AuthedRequest;
  return { actorId: r.userId!, ip: r.ip };
}

function mask(phone?: string | null) {
  const v = String(phone || "");
  return v.length > 4 ? `${v.slice(0, 4)}•••${v.slice(-3)}` : v;
}

function serializePayout(p: any, full = false) {
  return {
    id: sid(p._id),
    payoutReference: p.payoutReference,
    parentOrderId: sid(p.parentOrderId),
    sellerOrderId: p.sellerOrderId ? sid(p.sellerOrderId) : null,
    deliveryId: p.deliveryId ? sid(p.deliveryId) : null,
    refundId: p.refundId ? sid(p.refundId) : null,
    allocationId: p.allocationId ? sid(p.allocationId) : null,
    beneficiaryType: p.beneficiaryType,
    beneficiaryId: sid(p.beneficiaryId),
    destination: {
      operator: p.destination?.operator || "",
      channel: p.destination?.channel || "",
      phoneNumber: full ? p.destination?.phoneNumber || "" : mask(p.destination?.phoneNumber),
      accountName: p.destination?.accountName || "",
    },
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    providerPayoutId: p.providerPayoutId || "",
    attemptsCount: p.attemptsCount,
    lastAttemptAt: p.lastAttemptAt,
    nextRetryAt: p.nextRetryAt,
    failureCode: p.failureCode || "",
    failureMessage: p.failureMessage || "",
    completedAt: p.completedAt,
    batchId: p.batchId ? sid(p.batchId) : null,
    retryable: p.status === "failed",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(full ? { history: p.history } : {}),
  };
}

function serializeAttempt(a: any) {
  return {
    id: sid(a._id),
    attemptNumber: a.attemptNumber,
    attemptReference: a.attemptReference,
    providerReference: a.providerReference,
    status: a.status,
    failureCode: a.failureCode,
    failureMessage: a.failureMessage,
    requestPayload: a.requestPayload,
    responsePayload: a.responsePayload,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
  };
}

// ─── Reversements ────────────────────────────────────────────────────────────

adminFinanceRouter.get(
  "/payouts",
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.beneficiaryType) filter.beneficiaryType = String(req.query.beneficiaryType);
    if (req.query.parentOrderId) filter.parentOrderId = String(req.query.parentOrderId);
    const page = Math.max(1, Number(req.query.page || 1));
    const rows = await Payout.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * 50).limit(50).lean();
    res.json({ page, items: rows.map((p) => serializePayout(p)) });
  })
);

adminFinanceRouter.post(
  "/payouts/execute-batch",
  ...sensitive,
  validate(z.object({ payoutIds: z.array(z.string()).max(200).optional() })),
  ah(async (req, res) => {
    const batch = await executePayoutBatch(actor(req), req.body.payoutIds);
    res.json({ id: sid(batch._id), batchReference: batch.batchReference, status: batch.status, count: batch.payoutIds.length, totalAmount: batch.totalAmount });
  })
);

adminFinanceRouter.get(
  "/payouts/:id",
  ah(async (req, res) => {
    const payout = await Payout.findById(req.params.id).lean();
    if (!payout) throw notFound();
    const [attempts, allocation, webhooks] = await Promise.all([
      PayoutAttempt.find({ payoutId: payout._id }).sort({ attemptNumber: 1 }).lean(),
      payout.allocationId ? FinancialAllocation.findById(payout.allocationId).lean() : null,
      PayoutWebhookEvent.find({ reference: { $in: (await PayoutAttempt.find({ payoutId: payout._id }, "providerReference").lean()).map((a) => a.providerReference).filter(Boolean) } })
        .sort({ receivedAt: -1 })
        .limit(50)
        .lean(),
    ]);
    await auditFinance({ actorId: (req as AuthedRequest).userId, actorType: "admin", action: "payout.view", targetType: "Payout", targetId: payout._id, ip: req.ip });
    res.json({
      payout: serializePayout(payout, true),
      allocation,
      attempts: attempts.map(serializeAttempt),
      webhooks: webhooks.map((w) => ({ eventKey: w.eventKey, statusCode: w.statusCode, receivedAt: w.receivedAt, duplicates: w.duplicates, payload: w.payload })),
    });
  })
);

adminFinanceRouter.get(
  "/payouts/:id/attempts",
  ah(async (req, res) => {
    const rows = await PayoutAttempt.find({ payoutId: req.params.id }).sort({ attemptNumber: 1 }).lean();
    res.json(rows.map(serializeAttempt));
  })
);

adminFinanceRouter.post(
  "/payouts/:id/retry",
  ...sensitive,
  ah(async (req, res) => {
    const out = await retryFailedPayout(String(req.params.id), actor(req));
    res.json({ alreadySucceeded: out.alreadySucceeded, payout: out.payout ? serializePayout(out.payout) : null });
  })
);

adminFinanceRouter.post(
  "/payouts/:id/resolve-unknown",
  ...sensitive,
  validate(z.object({ outcome: z.enum(["succeeded", "failed"]), note: z.string().min(10).max(1000) })),
  ah(async (req, res) => {
    const payout = await resolveUnknownPayout(String(req.params.id), req.body.outcome, req.body.note, actor(req));
    res.json(payout ? serializePayout(payout) : null);
  })
);

adminFinanceRouter.post(
  "/payouts/:id/block",
  ...sensitive,
  validate(z.object({ reason: z.string().min(3).max(500) })),
  ah(async (req, res) => {
    res.json(serializePayout(await setPayoutBlocked(String(req.params.id), true, req.body.reason, actor(req))));
  })
);

adminFinanceRouter.post(
  "/payouts/:id/unblock",
  ...sensitive,
  validate(z.object({ reason: z.string().min(3).max(500) })),
  ah(async (req, res) => {
    res.json(serializePayout(await setPayoutBlocked(String(req.params.id), false, req.body.reason, actor(req))));
  })
);

adminFinanceRouter.get(
  "/payout-batches/:batchId",
  ah(async (req, res) => {
    const batch = await PayoutBatch.findById(req.params.batchId).lean();
    if (!batch) throw notFound();
    const payouts = await Payout.find({ _id: { $in: batch.payoutIds } }).lean();
    res.json({ ...batch, id: sid(batch._id), payouts: payouts.map((p) => serializePayout(p)) });
  })
);

// ─── Livraisons ──────────────────────────────────────────────────────────────

adminFinanceRouter.post(
  "/deliveries/:id/validate",
  ...sensitive,
  ah(async (req, res) => {
    const out = await confirmDelivery(req.params.id, { method: "admin_validation", by: (req as AuthedRequest).userId! });
    res.json({ deliveryId: sid(out.delivery._id), status: out.delivery.status, payoutId: out.payout ? sid(out.payout._id) : null });
  })
);

// ─── Vue commande (synthèse financière complète) ─────────────────────────────

const LABEL: Record<string, string> = {
  succeeded: "RÉUSSI",
  failed: "ÉCHOUÉ",
  processing: "EN COURS",
  queued: "EN FILE",
  eligible: "À LANCER",
  unknown: "INCONNU — À VÉRIFIER",
  blocked: "BLOQUÉ",
  cancelled: "ANNULÉ",
};

adminFinanceRouter.get(
  "/finance/parent-orders",
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.q) filter.orderNumber = String(req.query.q).toUpperCase();
    const rows = await ParentOrder.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json(rows.map((p) => ({ id: sid(p._id), orderNumber: p.orderNumber, status: p.status, payment: p.payment, summary: p.summary, createdAt: p.createdAt })));
  })
);

adminFinanceRouter.get(
  "/finance/orders/:id",
  ah(async (req, res) => {
    const parent = await ParentOrder.findById(req.params.id).lean();
    if (!parent) throw notFound();
    const [buyer, payment, orders, deliveries, allocations, payouts, refunds, ledger, paymentWebhooks] = await Promise.all([
      User.findById(parent.buyerId, "name email phone").lean(),
      Payment.findOne({ parentOrderId: parent._id, kind: "payment" }).lean(),
      Order.find({ _id: { $in: parent.sellerOrderIds } }).lean(),
      Delivery.find({ parentOrderId: parent._id }).lean(),
      FinancialAllocation.find({ parentOrderId: parent._id }).lean(),
      Payout.find({ parentOrderId: parent._id }).lean(),
      Refund.find({ parentOrderId: parent._id }).lean(),
      FinancialLedgerEntry.find({ parentOrderId: parent._id }).sort({ occurredAt: 1 }).lean(),
      PaymentWebhookEvent.find({ orderId: parent.orderNumber }).sort({ receivedAt: 1 }).lean(),
    ]);
    const sellers = await User.find({ _id: { $in: orders.map((o) => o.sellerId) } }, "name seller.shopName").lean();
    const attempts = await PayoutAttempt.find({ payoutId: { $in: payouts.map((p) => p._id) } }).sort({ attemptNumber: 1 }).lean();
    const payoutOf = (id: unknown) => payouts.find((p) => sid(p._id) === sid(id));

    const sellerOrders = orders.map((o) => {
      const alloc = allocations.find((a) => a.beneficiaryType === "seller" && sid(a.sellerOrderId) === sid(o._id));
      const payout = alloc?.payoutId ? payoutOf(alloc.payoutId) : null;
      const seller = sellers.find((s) => sid(s._id) === sid(o.sellerId));
      return {
        id: sid(o._id),
        orderNumber: o.orderNumber,
        seller: { id: sid(o.sellerId), name: (seller as any)?.seller?.shopName || seller?.name || "Vendeur" },
        grossAmount: o.amountGnf,
        commission: o.financialDetails?.platformCommissionAmount ?? o.commissionGnf,
        sellerNet: o.financialDetails?.sellerNetAmount ?? null,
        deliveryStatus: o.status,
        receivedAt: o.buyerConfirmedAt,
        allocation: alloc ? { id: sid(alloc._id), status: alloc.status, amount: alloc.amount, refundedAmount: alloc.refundedAmount, hold: alloc.hold } : null,
        payout: payout ? { ...serializePayout(payout), label: LABEL[payout.status] || payout.status } : null,
      };
    });
    const deliveryRows = deliveries.map((d) => {
      const alloc = allocations.find((a) => a.beneficiaryType === "courier" && sid(a.deliveryId) === sid(d._id));
      const payout = alloc?.payoutId ? payoutOf(alloc.payoutId) : null;
      return {
        id: sid(d._id),
        courierId: d.courierId ? sid(d.courierId) : null,
        deliveryFee: d.deliveryFee,
        status: d.status,
        confirmation: d.confirmation,
        allocation: alloc ? { id: sid(alloc._id), status: alloc.status, amount: alloc.amount } : null,
        payout: payout ? { ...serializePayout(payout), label: LABEL[payout.status] || payout.status } : null,
      };
    });
    const platform = allocations.find((a) => a.beneficiaryType === "platform");
    const sum = (status: string, types = ["seller", "courier"]) =>
      payouts.filter((p) => types.includes(p.beneficiaryType) && p.status === status).reduce((s, p) => s + p.amount, 0);

    await auditFinance({ actorId: (req as AuthedRequest).userId, actorType: "admin", action: "finance.order_view", targetType: "ParentOrder", targetId: parent._id, ip: req.ip });
    res.json({
      id: sid(parent._id),
      orderNumber: parent.orderNumber,
      status: parent.status,
      client: { id: sid(parent.buyerId), name: buyer?.name || "" },
      payment: payment
        ? {
            id: sid(payment._id),
            status: payment.status,
            amount: payment.amountGnf,
            providerOperationId: payment.providerOperationId,
            providerStatus: payment.providerStatus,
            paidAt: payment.paidAt,
            requiresReview: payment.requiresReview,
          }
        : null,
      summary: parent.summary,
      financialSummary: parent.financialSummary,
      sellerOrders,
      deliveries: deliveryRows,
      platformCommission: platform
        ? { amount: platform.amount - (platform.refundedAmount || 0), status: platform.status, label: platform.status === "retained" ? "CONSERVÉE SUR LE COMPTE MARCHAND" : platform.status }
        : null,
      situation: {
        collected: payment?.status === "success" ? payment.amountGnf : 0,
        payoutsSucceeded: sum("succeeded"),
        payoutsFailed: sum("failed"),
        payoutsPending: payouts
          .filter((p) => p.beneficiaryType !== "buyer" && ["eligible", "queued", "processing", "unknown", "blocked"].includes(p.status))
          .reduce((s, p) => s + p.amount, 0),
        refunded: sum("succeeded", ["buyer"]),
        commissionRetained: platform?.status === "retained" ? platform.amount - (platform.refundedAmount || 0) : 0,
      },
      actions: payouts.filter((p) => p.status === "failed").map((p) => ({ payoutId: sid(p._id), label: `Relancer uniquement ${p.payoutReference}` })),
      refunds,
      attempts: attempts.map(serializeAttempt),
      paymentWebhooks: paymentWebhooks.map((w) => ({ statusCode: w.statusCode, receivedAt: w.receivedAt, duplicates: w.duplicates })),
      ledger,
    });
  })
);

adminFinanceRouter.get(
  "/finance/ledger",
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.parentOrderId) filter.parentOrderId = String(req.query.parentOrderId);
    if (req.query.type) filter.type = String(req.query.type);
    res.json(await FinancialLedgerEntry.find(filter).sort({ occurredAt: -1 }).limit(500).lean());
  })
);

adminFinanceRouter.get(
  "/finance/refunds",
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = String(req.query.status);
    res.json(await Refund.find(filter).sort({ createdAt: -1 }).limit(200).lean());
  })
);

adminFinanceRouter.get(
  "/finance/payments",
  ah(async (req, res) => {
    const filter: Record<string, unknown> = { provider: "chapchappay", kind: "payment" };
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.requiresReview) filter.requiresReview = true;
    const rows = await Payment.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows.map((p) => ({ id: sid(p._id), reference: p.merchantTransactionId, parentOrderId: sid(p.parentOrderId), status: p.status, amount: p.amountGnf, providerStatus: p.providerStatus, providerOperationId: p.providerOperationId, paidAt: p.paidAt, requiresReview: p.requiresReview, createdAt: p.createdAt })));
  })
);

adminFinanceRouter.get(
  "/finance/reconciliation",
  ah(async (_req, res) => {
    const rows = await FinancialAuditLog.find({ action: "reconciliation.report" }).sort({ createdAt: -1 }).limit(20).lean();
    res.json(rows.map((r) => ({ id: sid(r._id), severity: r.severity, createdAt: r.createdAt, ...(r.meta as object) })));
  })
);

adminFinanceRouter.post(
  "/finance/reconciliation/run",
  sensitiveLimiter,
  ah(async (req, res) => {
    await auditFinance({ actorId: (req as AuthedRequest).userId, actorType: "admin", action: "reconciliation.manual_run", ip: req.ip });
    res.json(await runReconciliation());
  })
);

adminFinanceRouter.get(
  "/finance/audit",
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.severity) filter.severity = String(req.query.severity);
    if (req.query.targetId) filter.targetId = String(req.query.targetId);
    res.json(await FinancialAuditLog.find(filter).sort({ createdAt: -1 }).limit(300).lean());
  })
);
