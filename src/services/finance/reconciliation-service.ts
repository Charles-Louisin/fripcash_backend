/**
 * ReconciliationService : compare la base et le prestataire, signale les écarts.
 * Ne corrige jamais une différence en inventant un mouvement : il planifie des vérifications
 * et alerte. Les seules actions automatiques sont idempotentes (vérifier, recréer un Payout manquant).
 */
import { Payment } from "../../models/commerce.js";
import {
  FinancialAllocation,
  OutboxEvent,
  ParentOrder,
  Payout,
  PayoutAttempt,
} from "../../models/finance.js";
import { sid } from "../../utils/ids.js";
import { paymentProvider } from "../chapchappay.js";
import { alertFinance, auditFinance, enqueue, withTransaction } from "./core.js";
import { createPayoutForAllocation } from "./payout-service.js";

export type ReconciliationIssue = {
  kind: string;
  severity: "warning" | "critical";
  targetType: string;
  targetId: string;
  detail: string;
};

const bucket = (ms: number) => Math.floor(Date.now() / ms);

/** Paiements restés en attente : vérification planifiée (le webhook a pu se perdre). */
export async function reconcilePayments() {
  const old = new Date(Date.now() - 10 * 60_000);
  const rows = await Payment.find(
    { provider: "chapchappay", kind: "payment", status: "pending", createdAt: { $lt: old } },
    "_id"
  ).limit(200).lean();
  for (const p of rows) {
    await enqueue("payment.verify", { paymentId: sid(p._id) }, `payment.verify:${sid(p._id)}:rec:${bucket(10 * 60_000)}`);
  }
  return rows.length;
}

/**
 * Reversements bloqués : verrou expiré ou statut inconnu ⇒ VÉRIFICATION, jamais renvoi.
 * Un verrou expiré ne signifie pas que le transfert a échoué.
 */
export async function reconcilePayouts() {
  const now = new Date();
  const stale = await Payout.find(
    {
      $or: [
        { status: "processing", lockExpiresAt: { $lt: now } },
        { status: "processing", lockExpiresAt: null, updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } },
        { status: "unknown", updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } },
      ],
    },
    "_id"
  ).limit(200).lean();
  for (const p of stale) {
    await enqueue("payout.verify", { payoutId: sid(p._id) }, `payout.verify:${sid(p._id)}:rec:${bucket(5 * 60_000)}`);
  }
  // Payout en file sans tâche active (tâche perdue ou morte) : on la recrée, le verrou évite tout doublon.
  const queued = await Payout.find(
    { status: "queued", $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }], updatedAt: { $lt: new Date(now.getTime() - 2 * 60_000) } },
    "_id"
  ).limit(200).lean();
  for (const p of queued) {
    const active = await OutboxEvent.exists({
      type: "payout.execute",
      "payload.payoutId": sid(p._id),
      status: { $in: ["pending", "processing"] },
    });
    if (!active) {
      await enqueue("payout.execute", { payoutId: sid(p._id) }, `payout.execute:${sid(p._id)}:rec:${bucket(10 * 60_000)}`);
    }
  }
  return stale.length + queued.length;
}

/** Allocations éligibles sans Payout, ou restées trop longtemps sans traitement. */
export async function detectMissingPayouts(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];
  const orphan = await FinancialAllocation.find({ status: "eligible", payoutId: null, beneficiaryType: { $ne: "platform" } });
  for (const a of orphan) {
    await withTransaction((session) => createPayoutForAllocation(a, session));
    issues.push({ kind: "missing_payout_created", severity: "warning", targetType: "FinancialAllocation", targetId: sid(a._id), detail: a.allocationKey });
  }
  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  const lingering = await Payout.find(
    { status: { $in: ["eligible", "failed", "blocked"] }, updatedAt: { $lt: dayAgo } },
    "payoutReference status failureCode"
  ).limit(100).lean();
  for (const p of lingering) {
    issues.push({
      kind: "payout_lingering",
      severity: "warning",
      targetType: "Payout",
      targetId: sid(p._id),
      detail: `${p.payoutReference} ${p.status} ${p.failureCode || ""}`.trim(),
    });
  }
  return issues;
}

/** Doublons et déséquilibres : plusieurs succès pour un Payout, allocations ≠ encaissement. */
export async function detectDuplicateOperations(): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];
  const dup = await PayoutAttempt.aggregate([
    { $match: { status: "succeeded" } },
    { $group: { _id: "$payoutId", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  for (const d of dup) {
    issues.push({ kind: "duplicate_payout_success", severity: "critical", targetType: "Payout", targetId: sid(d._id), detail: `${d.n} transferts réussis` });
  }
  const recent = await ParentOrder.find({ createdAt: { $gt: new Date(Date.now() - 30 * 86_400_000) } }, "_id orderNumber summary").lean();
  for (const parent of recent) {
    const [sum] = await FinancialAllocation.aggregate([
      { $match: { parentOrderId: parent._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const payment = await Payment.findOne({ parentOrderId: parent._id, kind: "payment" }, "amountGnf").lean();
    if (!payment || !sum || sum.total !== payment.amountGnf || sum.total !== parent.summary?.totalPaid) {
      issues.push({
        kind: "allocation_imbalance",
        severity: "critical",
        targetType: "ParentOrder",
        targetId: sid(parent._id),
        detail: `${parent.orderNumber} : alloué ${sum?.total ?? 0}, encaissé ${payment?.amountGnf ?? "?"}`,
      });
    }
  }
  return issues;
}

/** Encaissements chez le prestataire sans paiement confirmé chez nous (et inversement). */
export async function reconcileProviderTransactions(pages = 3): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = [];
  for (let page = 1; page <= pages; page++) {
    const res = await paymentProvider().listTransactions(page);
    for (const tx of res.transactions) {
      if (!tx.order_id || tx.is_canceled || Number(tx.amount) <= 0) continue;
      if (!tx.order_id.startsWith("FC-")) continue;
      const payment = await Payment.findOne({ merchantTransactionId: tx.order_id }, "status amountGnf").lean();
      if (!payment) {
        issues.push({ kind: "unmatched_provider_payment", severity: "critical", targetType: "ProviderTransaction", targetId: tx.payment_reference || tx.order_id, detail: `${tx.order_id} ${tx.amount} GNF` });
      } else if (payment.status === "pending") {
        await enqueue("payment.verify", { paymentId: sid(payment._id) }, `payment.verify:${sid(payment._id)}:tx:${tx.payment_reference || page}`);
        issues.push({ kind: "payment_confirmation_missing", severity: "warning", targetType: "Payment", targetId: sid(payment._id), detail: tx.order_id });
      }
    }
    if (!res.pager?.total_pages || page >= res.pager.total_pages) break;
  }
  return issues;
}

/** Solde marchand ≥ sommes encore dues aux bénéficiaires. */
export async function reconcileProviderBalance(): Promise<ReconciliationIssue[]> {
  const info = await paymentProvider().getAccountInfo();
  const balance = Number(info.balance?.amount ?? NaN);
  const [due] = await FinancialAllocation.aggregate([
    { $match: { beneficiaryType: { $in: ["seller", "courier"] }, status: { $in: ["funded", "eligible", "payout_pending"] } } },
    { $group: { _id: null, total: { $sum: { $subtract: ["$amount", "$refundedAmount"] } } } },
  ]);
  const [refunds] = await Payout.aggregate([
    { $match: { beneficiaryType: "buyer", status: { $in: ["queued", "processing", "unknown", "eligible"] } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const liabilities = (due?.total || 0) + (refunds?.total || 0);
  if (Number.isFinite(balance) && balance < liabilities) {
    return [
      {
        kind: "balance_below_liabilities",
        severity: "critical",
        targetType: "ProviderAccount",
        targetId: "chapchappay",
        detail: `Solde ${balance} GNF < sommes dues ${liabilities} GNF`,
      },
    ];
  }
  return [];
}

export async function runReconciliation() {
  const issues: ReconciliationIssue[] = [];
  const safe = async (label: string, fn: () => Promise<ReconciliationIssue[]>) => {
    try {
      issues.push(...(await fn()));
    } catch (err) {
      issues.push({ kind: `${label}_failed`, severity: "warning", targetType: "Reconciliation", targetId: label, detail: String(err) });
    }
  };
  await reconcilePayments();
  await reconcilePayouts();
  await safe("missing_payouts", detectMissingPayouts);
  await safe("duplicates", detectDuplicateOperations);
  await safe("provider_transactions", () => reconcileProviderTransactions());
  await safe("provider_balance", reconcileProviderBalance);
  await auditFinance({
    actorType: "system",
    action: "reconciliation.report",
    targetType: "Reconciliation",
    severity: issues.some((i) => i.severity === "critical") ? "critical" : issues.length ? "warning" : "info",
    meta: { issues, checkedAt: new Date().toISOString() },
  });
  const critical = issues.filter((i) => i.severity === "critical");
  if (critical.length) {
    await alertFinance("Écarts financiers détectés", critical.map((i) => i.detail).slice(0, 5).join(" · "), {
      action: "reconciliation.critical",
      targetType: "Reconciliation",
      severity: "critical",
      meta: { count: critical.length },
    });
  }
  return { checkedAt: new Date(), issues };
}
