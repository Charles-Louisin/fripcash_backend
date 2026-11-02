/**
 * PayoutService : un Payout = un bénéficiaire + une somme. Exécuté uniquement par le worker.
 *
 * Garanties anti-double paiement :
 *  1. Référence unique par Payout et par tentative (contraintes MongoDB).
 *  2. Verrou atomique (statut attendu `queued`) avant tout appel externe.
 *  3. La tentative est enregistrée AVANT l'appel ; sa référence part comme `order_id`
 *     pour pouvoir retrouver le transfert après un timeout ou un redémarrage.
 *  4. Timeout / 5xx ⇒ `unknown`, jamais `failed` : on vérifie chez le prestataire avant toute relance.
 *  5. Un Payout `succeeded` n'est jamais renvoyé ; une relance cible un seul Payout `failed`.
 */
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { Order, Payment } from "../../models/commerce.js";
import {
  Delivery,
  FinancialAllocation,
  ParentOrder,
  Payout,
  PayoutAttempt,
  PayoutBatch,
  Refund,
} from "../../models/finance.js";
import { User } from "../../models/user.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { sid } from "../../utils/ids.js";
import { logger } from "../../utils/logger.js";
import { publicApiOrigin } from "../../utils/public-api.js";
import { ChapChapPayError, ccpChannelForOperator, paymentProvider } from "../chapchappay.js";
import { parseGnMobile } from "../gn-phone.js";
import { notify, notifyOrderParties } from "../notify.js";
import {
  alertFinance,
  auditFinance,
  enqueue,
  opts,
  recordLedger,
  shortId,
  withTransaction,
  type Session,
} from "./core.js";

const LOCK_MS = 5 * 60_000;
const VERIFY_MAX = 12;
const RETRY_COOLDOWN_MS = 10 * 60_000;
const TX_SCAN_PAGES = 5;

export function payoutCallbackUrl() {
  return `${publicApiOrigin()}/api/v1/payouts/webhook/chapchappay`;
}

type Destination = {
  operator: string;
  channel: string;
  phoneNumber: string;
  accountNumber: string;
  accountName: string;
};

/** Numéros fictifs du mode test Chap Chap Pay : 72… (Orange Money), 76… (MTN MoMo). */
function parseCcpTestNumber(value: string) {
  if (!env.chapchapAcceptTestNumbers) return null;
  const local = value.replace(/\D/g, "").replace(/^(00)?224(?=\d{9}$)/, "");
  const prefix = local.slice(0, 2);
  if (local.length !== 9 || (prefix !== "72" && prefix !== "76")) return null;
  const operator = (prefix === "72" ? "OM_GN" : "MTN_GN") as "OM_GN" | "MTN_GN";
  return { local, e164: `+224${local}`, operator };
}

/** Destination lue en base (profil), jamais fournie par le frontend. */
export async function resolveDestination(
  beneficiaryType: "seller" | "courier" | "buyer",
  userId: unknown,
  fallbackPhones: Array<string | null | undefined> = []
): Promise<Destination | null> {
  const user = await User.findById(userId).lean();
  const candidates =
    beneficiaryType === "seller"
      ? [user?.seller?.orangeMoneyPhone, user?.phone]
      : beneficiaryType === "courier"
        ? [user?.phone]
        : [...fallbackPhones, user?.phone];
  for (const value of candidates.filter(Boolean)) {
    const parsed = parseGnMobile(String(value)) || parseCcpTestNumber(String(value));
    if (!parsed) continue;
    return {
      operator: parsed.operator,
      channel: ccpChannelForOperator(parsed.operator),
      phoneNumber: parsed.e164,
      accountNumber: parsed.local,
      accountName: String((beneficiaryType === "seller" && user?.seller?.shopName) || user?.name || "").slice(0, 80),
    };
  }
  return null;
}

function orderPayoutStatus(status: string) {
  switch (status) {
    case "eligible":
      return "eligible";
    case "queued":
      return "pending";
    case "processing":
    case "unknown":
      return "processing";
    case "succeeded":
      return "paid";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return "not_eligible";
  }
}

async function syncSellerOrder(payout: any, session: Session) {
  if (payout.beneficiaryType !== "seller" || !payout.sellerOrderId) return;
  await Order.updateOne(
    { _id: payout.sellerOrderId },
    { $set: { payoutStatus: orderPayoutStatus(payout.status), payoutId: payout._id } },
    opts(session)
  );
}

function initialStatus(destination: Destination | null, amount: number, held: boolean) {
  if (held) return { status: "blocked", code: "DISPUTE", message: "Litige en cours" };
  if (!destination) {
    return { status: "failed", code: "DESTINATION_INVALID", message: "Aucun numéro Mobile Money guinéen (Orange 62 / MTN 65) valide." };
  }
  if (amount < env.chapchapMinPayoutGnf) {
    return { status: "blocked", code: "BELOW_MINIMUM", message: `Montant inférieur au minimum de ${env.chapchapMinPayoutGnf} GNF.` };
  }
  return { status: env.payoutAutoExecute ? "queued" : "eligible", code: "", message: "" };
}

/** Crée (ou retrouve) le Payout unique d'une allocation éligible. */
export async function createPayoutForAllocation(allocation: any, session: Session) {
  if (allocation.payoutId) {
    const existing = await Payout.findById(allocation.payoutId, null, opts(session));
    if (existing) return existing;
  }
  const parent = await ParentOrder.findById(allocation.parentOrderId, "orderNumber", opts(session)).lean();
  if (!parent) throw notFound("Commande parente introuvable");
  const type = allocation.beneficiaryType as "seller" | "courier";
  const payoutReference =
    type === "seller"
      ? `${parent.orderNumber}-SELLER-${shortId(allocation.sellerOrderId)}`
      : `${parent.orderNumber}-COURIER-${shortId(allocation.deliveryId)}`;
  const amount = allocation.amount - (allocation.refundedAmount || 0);
  const destination = await resolveDestination(type, allocation.beneficiaryId);
  const init = initialStatus(destination, amount, Boolean(allocation.hold?.active));
  const payoutId = new mongoose.Types.ObjectId();
  await Payout.updateOne(
    { payoutReference },
    {
      $setOnInsert: {
        _id: payoutId,
        payoutReference,
        parentOrderId: allocation.parentOrderId,
        allocationId: allocation._id,
        sellerOrderId: allocation.sellerOrderId || null,
        deliveryId: allocation.deliveryId || null,
        beneficiaryType: type,
        beneficiaryId: allocation.beneficiaryId,
        destination: destination || {},
        amount,
        currency: allocation.currency || "GNF",
        provider: "chapchappay",
        status: init.status,
        failureCode: init.code,
        failureMessage: init.message,
        history: [{ status: init.status, at: new Date(), note: init.message || "Reversement créé" }],
      },
    },
    { upsert: true, ...opts(session) }
  );
  const payout = await Payout.findOne({ payoutReference }, null, opts(session));
  if (!payout) throw notFound("Payout introuvable");

  allocation.status = "payout_pending";
  allocation.payoutId = payout._id;
  allocation.history.push({ status: "payout_pending", at: new Date(), note: payoutReference });
  await allocation.save(opts(session));
  if (type === "courier" && allocation.deliveryId) {
    await Delivery.updateOne({ _id: allocation.deliveryId }, { $set: { courierPayoutId: payout._id } }, opts(session));
  }
  await syncSellerOrder(payout, session);
  await recordLedger(
    {
      entryKey: `payout_requested:${payoutReference}`,
      type: "payout_requested",
      amount,
      direction: "internal",
      parentOrderId: allocation.parentOrderId,
      sellerOrderId: allocation.sellerOrderId,
      allocationId: allocation._id,
      payoutId: payout._id,
      beneficiaryType: type,
      beneficiaryId: allocation.beneficiaryId,
      reference: payoutReference,
    },
    session
  );
  if (payout.status === "queued") {
    await enqueue("payout.execute", { payoutId: sid(payout._id) }, `payout.execute:${sid(payout._id)}:1`, { session });
  }
  if (init.code === "DESTINATION_INVALID" || init.code === "BELOW_MINIMUM") {
    await auditFinance(
      { actorType: "system", action: "payout.not_executable", targetType: "Payout", targetId: payout._id, severity: "warning", meta: { code: init.code } },
      session
    );
  }
  return payout;
}

/** Exécution d'un remboursement acheteur : même mécanique, bénéficiaire `buyer`. */
export async function createRefundPayout(refund: any, order: any, session: Session) {
  const payment = refund.paymentId ? await Payment.findById(refund.paymentId, "phoneE164", opts(session)).lean() : null;
  const destination = await resolveDestination("buyer", refund.buyerId, [
    payment?.phoneE164,
    order?.address?.paymentPhone,
    order?.address?.phone,
  ]);
  const init = initialStatus(destination, refund.amount, false);
  // Un remboursement validé part sans attendre une approbation supplémentaire.
  const status = init.status === "eligible" ? "queued" : init.status;
  const payoutReference = `${refund.refundReference}-BUYER`;
  await Payout.updateOne(
    { payoutReference },
    {
      $setOnInsert: {
        payoutReference,
        parentOrderId: refund.parentOrderId,
        refundId: refund._id,
        sellerOrderId: refund.sellerOrderId,
        beneficiaryType: "buyer",
        beneficiaryId: refund.buyerId,
        destination: destination || {},
        amount: refund.amount,
        provider: "chapchappay",
        status,
        failureCode: init.code,
        failureMessage: init.message,
        history: [{ status, at: new Date(), note: init.message || "Remboursement acheteur" }],
      },
    },
    { upsert: true, ...opts(session) }
  );
  const payout = await Payout.findOne({ payoutReference }, null, opts(session));
  await Refund.updateOne(
    { _id: refund._id },
    {
      $set: { payoutId: payout!._id, status: status === "queued" ? "processing" : "requires_manual" },
      $push: { history: { status: status === "queued" ? "processing" : "requires_manual", at: new Date(), note: init.message } },
    },
    opts(session)
  );
  if (status === "queued") {
    await enqueue("payout.execute", { payoutId: sid(payout!._id) }, `payout.execute:${sid(payout!._id)}:1`, { session });
  }
  return payout;
}

export async function cancelOpenPayout(payoutId: unknown, reason: string, session: Session) {
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: { $in: ["blocked", "eligible", "queued", "failed"] } },
    { $set: { status: "cancelled", failureMessage: reason }, $push: { history: { status: "cancelled", at: new Date(), note: reason } } },
    { new: true, ...opts(session) }
  );
  if (payout && payout.beneficiaryType === "seller") {
    await Order.updateOne({ _id: payout.sellerOrderId }, { $set: { payoutStatus: "refunded" } }, opts(session));
  }
  return payout;
}

/** Après un remboursement partiel : le reversement non encore parti suit la somme restant due. */
export async function resizeOpenPayout(payoutId: unknown, amount: number, session: Session) {
  const inFlight = await PayoutAttempt.exists({ payoutId, status: { $in: ["created", "processing", "unknown"] } }).session(session);
  if (inFlight) throw conflict("PAYOUT_IN_FLIGHT", "Reversement en cours : montant non modifiable.");
  await Payout.updateOne(
    { _id: payoutId, status: { $in: ["blocked", "eligible", "queued", "failed"] } },
    { $set: { amount }, $push: { history: { status: "resized", at: new Date(), note: `Montant dû ramené à ${amount} GNF (remboursement)` } } },
    opts(session)
  );
}

/** Litige levé : le Payout bloqué repart (queued) ou attend l'admin (eligible). */
export async function requeueBlockedPayout(payoutId: unknown, session: Session) {
  const next = env.payoutAutoExecute ? "queued" : "eligible";
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: "blocked", failureCode: "DISPUTE" },
    { $set: { status: next, failureCode: "", failureMessage: "" }, $push: { history: { status: next, at: new Date(), note: "Litige levé" } } },
    { new: true, ...opts(session) }
  );
  if (!payout) return null;
  await syncSellerOrder(payout, session);
  if (next === "queued") {
    await enqueue("payout.execute", { payoutId: sid(payout._id) }, `payout.execute:${sid(payout._id)}:unblock:${Date.now()}`, { session });
  }
  return payout;
}

// ─── Résultat d'une tentative ────────────────────────────────────────────────

type Outcome = {
  status: "succeeded" | "failed" | "processing" | "unknown";
  providerReference?: string;
  response?: unknown;
  code?: string;
  message?: string;
};

async function onSucceeded(payout: any, session: Session) {
  await recordLedger(
    {
      entryKey: `payout_succeeded:${payout.payoutReference}`,
      type: payout.beneficiaryType === "buyer" ? "refund_succeeded" : "payout_succeeded",
      amount: payout.amount,
      direction: "out",
      parentOrderId: payout.parentOrderId,
      sellerOrderId: payout.sellerOrderId,
      allocationId: payout.allocationId,
      payoutId: payout._id,
      refundId: payout.refundId,
      beneficiaryType: payout.beneficiaryType,
      beneficiaryId: payout.beneficiaryId,
      reference: payout.payoutReference,
    },
    session
  );
  if (payout.allocationId) {
    await FinancialAllocation.updateOne(
      { _id: payout.allocationId, status: { $ne: "paid" } },
      { $set: { status: "paid" }, $push: { history: { status: "paid", at: new Date(), note: payout.payoutReference } } },
      opts(session)
    );
  }
  if (payout.beneficiaryType === "seller") {
    const order = await Order.findById(payout.sellerOrderId, null, opts(session));
    if (order) {
      order.payoutStatus = "paid";
      order.escrowStatus = "released";
      if (order.status === "DELIVERED") {
        order.status = "FUNDS_RELEASED";
        order.timeline.push({ status: "FUNDS_RELEASED", at: new Date(), note: "Reversement vendeur effectué via Chap Chap Pay" });
      }
      await order.save(opts(session));
    }
  }
  if (payout.beneficiaryType === "buyer" && payout.refundId) {
    const refund = await Refund.findByIdAndUpdate(
      payout.refundId,
      { $set: { status: "succeeded" }, $push: { history: { status: "succeeded", at: new Date(), note: payout.payoutReference } } },
      { new: true, ...opts(session) }
    );
    if (refund?.paymentId) {
      const refunded = await Refund.find({ paymentId: refund.paymentId, status: "succeeded" }, "amount", opts(session)).lean();
      const payment = await Payment.findById(refund.paymentId, null, opts(session));
      if (payment) {
        const total = refunded.reduce((s, r) => s + r.amount, 0);
        payment.status = total >= payment.amountGnf ? "refunded" : "partially_refunded";
        await payment.save(opts(session));
        await ParentOrder.updateOne({ _id: refund.parentOrderId }, { $set: { "payment.status": payment.status } }, opts(session));
      }
    }
    if (refund?.sellerOrderId && refund.kind === "full") {
      const order = await Order.findById(refund.sellerOrderId, null, opts(session));
      if (order && order.status !== "REFUNDED") {
        order.status = "REFUNDED";
        order.escrowStatus = "refunded";
        order.timeline.push({ status: "REFUNDED", at: new Date(), note: "Remboursement acheteur effectué via Chap Chap Pay" });
        await order.save(opts(session));
      }
    }
  }
}

/** Applique un résultat vérifié à UNE tentative et à SON Payout. Idempotent. */
export async function applyAttemptOutcome(payoutId: unknown, attemptId: unknown, outcome: Outcome) {
  const result = await withTransaction(async (session) => {
    const attempt = await PayoutAttempt.findById(attemptId, null, opts(session));
    const payout = await Payout.findById(payoutId, null, opts(session));
    if (!attempt || !payout) return null;
    const now = new Date();

    if (outcome.status === "succeeded") {
      if (attempt.status === "succeeded" && payout.status === "succeeded") return { payout, changed: false };
      const otherSuccess = await PayoutAttempt.exists({ payoutId, status: "succeeded", _id: { $ne: attempt._id } }).session(session);
      attempt.status = "succeeded";
      attempt.completedAt = now;
      if (outcome.providerReference) attempt.providerReference = outcome.providerReference;
      if (outcome.response !== undefined) attempt.responsePayload = outcome.response as any;
      await attempt.save(opts(session));
      if (otherSuccess) {
        await auditFinance(
          { actorType: "system", action: "payout.duplicate_success", targetType: "Payout", targetId: payout._id, severity: "critical", meta: { attemptReference: attempt.attemptReference } },
          session
        );
      }
      const wasCancelled = payout.status === "cancelled";
      payout.status = "succeeded";
      payout.completedAt = now;
      payout.failureCode = "";
      payout.failureMessage = "";
      payout.lockedBy = null;
      payout.lockExpiresAt = null;
      if (outcome.providerReference) payout.providerPayoutId = outcome.providerReference;
      payout.history.push({ status: "succeeded", at: now, note: attempt.attemptReference });
      await payout.save(opts(session));
      await syncSellerOrder(payout, session);
      await onSucceeded(payout, session);
      return { payout, changed: true, duplicate: Boolean(otherSuccess), wasCancelled };
    }

    if (attempt.status === "succeeded") return { payout, changed: false };

    if (outcome.status === "failed") {
      attempt.status = "failed";
      attempt.completedAt = now;
      attempt.failureCode = outcome.code || "PROVIDER_ERROR";
      attempt.failureMessage = (outcome.message || "").slice(0, 500);
      if (outcome.providerReference) attempt.providerReference = outcome.providerReference;
      if (outcome.response !== undefined) attempt.responsePayload = outcome.response as any;
      await attempt.save(opts(session));
      const stillOpen = await PayoutAttempt.exists({ payoutId, status: { $in: ["created", "processing", "unknown"] } }).session(session);
      if (!stillOpen && ["processing", "unknown"].includes(payout.status)) {
        payout.status = "failed";
        payout.failureCode = attempt.failureCode;
        payout.failureMessage = attempt.failureMessage;
        payout.lockedBy = null;
        payout.lockExpiresAt = null;
        payout.history.push({ status: "failed", at: now, note: `${attempt.attemptReference} : ${attempt.failureMessage}` });
        await payout.save(opts(session));
        await syncSellerOrder(payout, session);
        if (payout.refundId) {
          await Refund.updateOne({ _id: payout.refundId }, { $set: { status: "failed" }, $push: { history: { status: "failed", at: now, note: attempt.failureMessage } } }, opts(session));
        }
      }
      await recordLedger(
        {
          entryKey: `payout_failed:${attempt.attemptReference}`,
          type: "payout_failed",
          amount: payout.amount,
          direction: "internal",
          parentOrderId: payout.parentOrderId,
          payoutId: payout._id,
          attemptId: attempt._id,
          beneficiaryType: payout.beneficiaryType,
          beneficiaryId: payout.beneficiaryId,
          reference: attempt.attemptReference,
          note: attempt.failureMessage,
        },
        session
      );
      return { payout, changed: true };
    }

    // processing / unknown : en attente de confirmation.
    if (["created", "processing", "unknown"].includes(attempt.status)) {
      attempt.status = outcome.status;
      if (outcome.providerReference) attempt.providerReference = outcome.providerReference;
      if (outcome.response !== undefined) attempt.responsePayload = outcome.response as any;
      await attempt.save(opts(session));
    }
    if (["processing", "unknown"].includes(payout.status)) {
      payout.status = outcome.status;
      payout.lockedBy = null;
      payout.lockExpiresAt = null;
      if (outcome.providerReference) payout.providerPayoutId = outcome.providerReference;
      if (outcome.status === "unknown") {
        payout.history.push({ status: "unknown", at: now, note: outcome.message || "Réponse du prestataire non reçue" });
      }
      await payout.save(opts(session));
      await syncSellerOrder(payout, session);
      if (outcome.status === "unknown") {
        await recordLedger(
          {
            entryKey: `payout_unknown:${attempt.attemptReference}`,
            type: "payout_unknown",
            amount: payout.amount,
            direction: "internal",
            parentOrderId: payout.parentOrderId,
            payoutId: payout._id,
            attemptId: attempt._id,
            reference: attempt.attemptReference,
            note: outcome.message || "",
          },
          session
        );
      }
    }
    return { payout, changed: true };
  });

  if (result?.changed && result.payout) await afterOutcome(result.payout, outcome, result);
  return result?.payout || null;
}

async function afterOutcome(payout: any, outcome: Outcome, flags: { duplicate?: boolean; wasCancelled?: boolean }) {
  try {
    if (flags.duplicate || flags.wasCancelled) {
      await alertFinance(
        "Reversement en double ou inattendu",
        `${payout.payoutReference} : un transfert a réussi alors qu'il ne devait plus partir. Recouvrement à prévoir.`,
        { action: "payout.unexpected_success", targetType: "Payout", targetId: payout._id, severity: "critical" }
      );
    }
    if (outcome.status === "succeeded") {
      const { refreshParentOrderStatus } = await import("./financial-service.js");
      await refreshParentOrderStatus(payout.parentOrderId);
      const label = payout.beneficiaryType === "buyer" ? "Remboursement effectué" : "Reversement effectué";
      await notify(sid(payout.beneficiaryId), "payment", label, `${payout.amount.toLocaleString("fr-FR")} GNF envoyés sur ton Mobile Money.`, {
        payoutId: sid(payout._id),
      });
      if (payout.beneficiaryType === "seller" && payout.sellerOrderId) {
        const order = await Order.findById(payout.sellerOrderId);
        if (order) await notifyOrderParties(order, "FUNDS_RELEASED", "Les fonds ont été versés au vendeur");
      }
    }
    if (outcome.status === "failed") {
      await alertFinance("Reversement échoué", `${payout.payoutReference} (${payout.amount} GNF) : ${outcome.message || outcome.code}`, {
        action: "payout.failed",
        targetType: "Payout",
        targetId: payout._id,
        meta: { code: outcome.code },
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "payout post-processing failed");
  }
}

// ─── Exécution (worker uniquement) ───────────────────────────────────────────

export type JobResult = { reschedule?: number };

async function releaseLock(payoutId: unknown, workerId: string, fields: Record<string, unknown>, note?: string) {
  const update: any = { $set: { ...fields, lockedBy: null, lockExpiresAt: null } };
  if (note) update.$push = { history: { status: String(fields.status || ""), at: new Date(), note } };
  await Payout.updateOne({ _id: payoutId, lockedBy: workerId }, update);
}

export async function executePayout(payoutId: string, workerId: string): Promise<JobResult> {
  const now = new Date();
  // Verrou : un seul worker peut faire passer ce Payout de `queued` à `processing`.
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: "queued", $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
    { $set: { status: "processing", lockedBy: workerId, lockedAt: now, lockExpiresAt: new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  );
  if (!payout) {
    const current = await Payout.findById(payoutId, "status nextRetryAt").lean();
    if (current?.status === "queued" && current.nextRetryAt) {
      return { reschedule: Math.max(1_000, new Date(current.nextRetryAt).getTime() - Date.now()) };
    }
    return {};
  }

  const open = await PayoutAttempt.findOne({ payoutId, status: { $in: ["created", "processing", "unknown"] } }).lean();
  if (open) {
    // Une tentative précédente n'est pas tranchée : on vérifie, on ne renvoie pas.
    await releaseLock(payoutId, workerId, { status: "unknown" }, "Tentative précédente non tranchée");
    await enqueue("payout.verify", { payoutId }, `payout.verify:${payoutId}:${sid(open._id)}`);
    return {};
  }

  // Contrôles métier : la somme est-elle toujours due, et exactement ce montant ?
  if (payout.allocationId) {
    const allocation = await FinancialAllocation.findById(payout.allocationId).lean();
    const due = allocation ? allocation.amount - (allocation.refundedAmount || 0) : 0;
    if (!allocation || allocation.status !== "payout_pending") {
      await releaseLock(payoutId, workerId, { status: "cancelled", failureCode: "NOT_DUE" }, "Allocation plus due");
      return {};
    }
    if (allocation.hold?.active) {
      await releaseLock(payoutId, workerId, { status: "blocked", failureCode: "DISPUTE", failureMessage: allocation.hold.reason }, "Litige");
      return {};
    }
    if (due !== payout.amount) {
      await releaseLock(payoutId, workerId, { status: "failed", failureCode: "AMOUNT_MISMATCH" }, `Dû ${due} ≠ ${payout.amount}`);
      await alertFinance("Montant de reversement incohérent", `${payout.payoutReference} : dû ${due} GNF, Payout ${payout.amount} GNF.`, {
        action: "payout.amount_mismatch",
        targetType: "Payout",
        targetId: payout._id,
        severity: "critical",
      });
      return {};
    }
  } else if (payout.refundId) {
    const refund = await Refund.findById(payout.refundId).lean();
    if (!refund || !["requested", "processing", "failed"].includes(refund.status)) {
      await releaseLock(payoutId, workerId, { status: "cancelled", failureCode: "NOT_DUE" }, "Remboursement clôturé");
      return {};
    }
  }
  if (!payout.destination?.accountNumber || !payout.destination?.channel) {
    await releaseLock(payoutId, workerId, { status: "failed", failureCode: "DESTINATION_INVALID", failureMessage: "Destination Mobile Money manquante" });
    return {};
  }

  // Solde disponible chez le prestataire.
  try {
    const info = await paymentProvider().getAccountInfo();
    if (info.services && info.services.is_api_push_enabled === false) {
      await releaseLock(payoutId, workerId, { status: "queued", nextRetryAt: new Date(Date.now() + 60 * 60_000), failureCode: "PUSH_DISABLED" });
      await alertFinance("PUSH API désactivée", "Le service PUSH Chap Chap Pay n'est pas activé sur le compte marchand.", {
        action: "provider.push_disabled",
        targetId: payout._id,
        severity: "critical",
      });
      return { reschedule: 60 * 60_000 };
    }
    const balance = Number(info.balance?.amount ?? NaN);
    if (Number.isFinite(balance) && balance < payout.amount) {
      await releaseLock(payoutId, workerId, {
        status: "queued",
        nextRetryAt: new Date(Date.now() + 30 * 60_000),
        failureCode: "INSUFFICIENT_BALANCE",
        failureMessage: `Solde ${balance} GNF < ${payout.amount} GNF`,
      });
      await alertFinance("Solde marchand insuffisant", `${payout.payoutReference} attend : solde ${balance} GNF, besoin ${payout.amount} GNF.`, {
        action: "provider.insufficient_balance",
        targetType: "Payout",
        targetId: payout._id,
      });
      return { reschedule: 30 * 60_000 };
    }
  } catch (err) {
    // Rien n'a été envoyé : on réessaie plus tard sans créer de tentative.
    await releaseLock(payoutId, workerId, { status: "queued", nextRetryAt: new Date(Date.now() + 5 * 60_000), failureCode: "BALANCE_CHECK_FAILED" });
    logger.warn({ err: String(err), payoutId }, "balance check failed");
    return { reschedule: 5 * 60_000 };
  }

  const attemptNumber = (await PayoutAttempt.countDocuments({ payoutId })) + 1;
  const attemptReference = `${payout.payoutReference}-A${attemptNumber}`;
  const request = {
    orderId: attemptReference,
    amountGnf: payout.amount,
    channel: payout.destination.channel as "orange_money" | "mtn_momo",
    accountNumber: payout.destination.accountNumber,
    accountName: payout.destination.accountName || undefined,
    callbackUrl: payoutCallbackUrl(),
  };
  // Persistée AVANT l'appel : un crash juste après laisse une trace à vérifier, jamais un envoi fantôme.
  const attempt = await PayoutAttempt.create({
    payoutId,
    attemptNumber,
    attemptReference,
    status: "created",
    requestPayload: { ...request, accountNumber: `***${request.accountNumber.slice(-3)}` },
    workerId,
  });
  await Payout.updateOne({ _id: payoutId }, { $set: { attemptsCount: attemptNumber, lastAttemptAt: new Date() } });

  let outcome: Outcome;
  try {
    const res = await paymentProvider().pushRequest(request);
    outcome =
      res.status === "success"
        ? { status: "succeeded", providerReference: res.request_id, response: res }
        : res.status === "error"
          ? { status: "failed", providerReference: res.request_id, response: res, code: "PROVIDER_ERROR", message: res.status_message || "Transfert refusé par l'opérateur" }
          : { status: "processing", providerReference: res.request_id, response: res };
  } catch (err) {
    const e = err instanceof ChapChapPayError ? err : new ChapChapPayError("unknown", String(err));
    if (e.kind === "unknown") {
      outcome = { status: "unknown", message: e.message };
    } else {
      // Refus explicite ou requête jamais partie : aucun transfert n'a été exécuté.
      outcome = { status: "failed", code: e.kind === "rejected" ? "PROVIDER_REJECTED" : e.kind === "config" ? "PROVIDER_CONFIG" : "NOT_SENT", message: e.message, response: e.body ?? null };
    }
  }
  const updated = await applyAttemptOutcome(payoutId, attempt._id, outcome);

  if (outcome.status === "processing" || outcome.status === "unknown") {
    await enqueue("payout.verify", { payoutId }, `payout.verify:${payoutId}:${sid(attempt._id)}`, {
      runAt: new Date(Date.now() + 60_000),
    });
  }
  // Requête jamais partie : relance automatique sûre, dans la limite des tentatives.
  if (outcome.status === "failed" && (outcome.code === "NOT_SENT" || outcome.code === "PROVIDER_CONFIG") && updated) {
    if (attemptNumber < env.payoutMaxAttempts) {
      const delay = outcome.code === "PROVIDER_CONFIG" ? 60 * 60_000 : 2 * 60_000 * attemptNumber;
      const requeued = await Payout.findOneAndUpdate(
        { _id: payoutId, status: "failed" },
        { $set: { status: "queued", nextRetryAt: new Date(Date.now() + delay) } },
        { new: true }
      );
      if (requeued) {
        await enqueue("payout.execute", { payoutId }, `payout.execute:${payoutId}:${attemptNumber + 1}`, {
          runAt: new Date(Date.now() + delay),
        });
      }
    }
  }
  return {};
}

async function findTransferInAccount(orderId: string) {
  for (let page = 1; page <= TX_SCAN_PAGES; page++) {
    const res = await paymentProvider().listTransactions(page);
    const hit = res.transactions.find((t) => t.order_id === orderId);
    if (hit) return hit;
    const total = res.pager?.total_pages ?? page;
    if (page >= total || !res.transactions.length) break;
  }
  return null;
}

/** Vérifie chez le prestataire les tentatives non tranchées d'UN Payout. */
export async function verifyPayout(payoutId: string): Promise<JobResult> {
  const payout = await Payout.findById(payoutId);
  if (!payout) return {};
  const open = await PayoutAttempt.find({ payoutId, status: { $in: ["created", "processing", "unknown"] } });
  if (!open.length) {
    if ((payout.status === "processing" || payout.status === "unknown") && !(await PayoutAttempt.exists({ payoutId, status: "succeeded" }))) {
      // Verrouillé mais aucune tentative créée : rien n'est parti, on remet en file.
      const back = await Payout.findOneAndUpdate(
        { _id: payoutId, status: { $in: ["processing", "unknown"] }, lockExpiresAt: { $lt: new Date() } },
        { $set: { status: "queued", lockedBy: null, lockExpiresAt: null } },
        { new: true }
      );
      if (back) await enqueue("payout.execute", { payoutId }, `payout.execute:${payoutId}:recover:${Date.now()}`);
    }
    return {};
  }

  let unresolved = 0;
  for (const attempt of open) {
    let outcome: Outcome | null = null;
    try {
      if (attempt.providerReference) {
        const status = await paymentProvider().getPushRequest(attempt.providerReference);
        if (status?.status === "success") outcome = { status: "succeeded", providerReference: status.request_id, response: status };
        else if (status?.status === "error") outcome = { status: "failed", code: "PROVIDER_ERROR", message: status.status_message || "Transfert en échec", providerReference: status.request_id, response: status };
        else if (status) outcome = { status: "processing", providerReference: status.request_id, response: status };
      }
      if (!outcome || outcome.status === "processing") {
        const tx = await findTransferInAccount(attempt.attemptReference);
        if (tx && !tx.is_canceled) outcome = { status: "succeeded", providerReference: attempt.providerReference || tx.payment_reference || "", response: tx };
      }
    } catch (err) {
      logger.warn({ err: String(err), payoutId }, "payout verification failed");
    }
    if (outcome && outcome.status !== "processing") {
      await applyAttemptOutcome(payoutId, attempt._id, outcome);
    } else {
      unresolved++;
    }
  }
  if (!unresolved) return {};
  const fresh = await Payout.findByIdAndUpdate(payoutId, { $inc: { verifyCount: 1 } }, { new: true });
  const count = fresh?.verifyCount || 0;
  if (count >= VERIFY_MAX) {
    await alertFinance(
      "Reversement à statut inconnu",
      `${payout.payoutReference} : impossible de confirmer le transfert après ${count} vérifications. Contrôle manuel requis dans le tableau de bord Chap Chap Pay.`,
      { action: "payout.unknown_unresolved", targetType: "Payout", targetId: payout._id, severity: "critical" }
    );
    return {};
  }
  return { reschedule: Math.min(30 * 60_000, 60_000 * 2 ** Math.min(count, 5)) };
}

// ─── Actions administrateur ──────────────────────────────────────────────────

type Actor = { actorId: string; ip?: string };

/** Relance exclusivement CE Payout, uniquement s'il est définitivement en échec. */
export async function retryFailedPayout(payoutId: string, actor: Actor) {
  const payout = await Payout.findById(payoutId);
  if (!payout) throw notFound("Reversement introuvable");
  if (payout.status !== "failed") {
    throw conflict("NOT_FAILED", `Seul un reversement en échec peut être relancé (statut actuel : ${payout.status}).`);
  }
  if (payout.allocationId) {
    const allocation = await FinancialAllocation.findById(payout.allocationId).lean();
    if (!allocation || allocation.status !== "payout_pending") throw conflict("NOT_DUE", "Cette somme n'est plus due.");
    if (allocation.hold?.active) throw conflict("ON_HOLD", "Cette somme est bloquée par un litige.");
    if (allocation.amount - (allocation.refundedAmount || 0) !== payout.amount) throw conflict("AMOUNT_MISMATCH", "Montant incohérent avec l'allocation.");
  }
  if (await PayoutAttempt.exists({ payoutId, status: { $in: ["created", "processing", "unknown"] } })) {
    throw conflict("ATTEMPT_OPEN", "Une tentative est encore en cours de vérification.");
  }
  if (payout.lastAttemptAt && Date.now() - payout.lastAttemptAt.getTime() < RETRY_COOLDOWN_MS) {
    throw conflict("COOLDOWN", "Attends quelques minutes : un succès tardif de l'opérateur est encore possible.");
  }
  // Un « échec » peut devenir un succès tardif : on revérifie toutes les tentatives avant de renvoyer.
  const previous = await PayoutAttempt.find({ payoutId, status: "failed" });
  for (const attempt of previous) {
    if (attempt.failureCode === "NOT_SENT" || attempt.failureCode === "PROVIDER_REJECTED") continue;
    let late = false;
    if (attempt.providerReference) {
      const st = await paymentProvider().getPushRequest(attempt.providerReference);
      late = st?.status === "success";
    }
    if (!late) {
      const tx = await findTransferInAccount(attempt.attemptReference);
      late = Boolean(tx && !tx.is_canceled);
    }
    if (late) {
      await applyAttemptOutcome(payoutId, attempt._id, { status: "succeeded", providerReference: attempt.providerReference });
      await auditFinance({ actorId: actor.actorId, actorType: "admin", action: "payout.retry_found_late_success", targetType: "Payout", targetId: payoutId, ip: actor.ip });
      return { payout: await Payout.findById(payoutId), alreadySucceeded: true };
    }
  }

  const type = payout.beneficiaryType;
  let destination = payout.destination as any;
  if (type !== "buyer") {
    const fresh = await resolveDestination(type, payout.beneficiaryId);
    if (!fresh) throw badRequest("DESTINATION_INVALID", "Le bénéficiaire n'a toujours pas de numéro Mobile Money valide.");
    destination = fresh;
  }
  const queued = await Payout.findOneAndUpdate(
    { _id: payoutId, status: "failed" },
    {
      $set: { status: "queued", nextRetryAt: null, failureCode: "", failureMessage: "", destination },
      $push: { history: { status: "queued", at: new Date(), note: "Relance administrateur" } },
    },
    { new: true }
  );
  if (!queued) throw conflict("NOT_FAILED", "Le reversement a changé d'état entre-temps.");
  await syncSellerOrder(queued, null);
  await enqueue("payout.execute", { payoutId }, `payout.execute:${payoutId}:retry:${queued.attemptsCount + 1}`);
  await auditFinance({
    actorId: actor.actorId,
    actorType: "admin",
    action: "payout.retry",
    targetType: "Payout",
    targetId: payoutId,
    ip: actor.ip,
    meta: { payoutReference: payout.payoutReference, attempt: queued.attemptsCount + 1, amount: payout.amount },
  });
  return { payout: queued, alreadySucceeded: false };
}

/**
 * Lot de reversements : Chap Chap Pay n'a pas de PUSH groupé, donc chaque Payout part
 * en requête individuelle et garde sa référence et son statut. Le lot n'est qu'un regroupement.
 */
export async function executePayoutBatch(actor: Actor, payoutIds?: string[]) {
  const filter: any = { status: { $in: ["eligible", "queued"] }, batchId: null };
  if (payoutIds?.length) filter._id = { $in: payoutIds };
  const rows = await Payout.find(filter).limit(200);
  if (!rows.length) throw badRequest("EMPTY_BATCH", "Aucun reversement éligible à envoyer.");
  const batch = await PayoutBatch.create({
    batchReference: `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${shortId(new mongoose.Types.ObjectId())}`,
    payoutIds: rows.map((r) => r._id),
    totalAmount: rows.reduce((s, r) => s + r.amount, 0),
    status: "submitted",
    createdBy: actor.actorId,
    submittedAt: new Date(),
    results: rows.map((r) => ({ payoutId: r._id, payoutReference: r.payoutReference, status: r.status })),
  });
  for (const row of rows) {
    const queued = await Payout.findOneAndUpdate(
      { _id: row._id, status: { $in: ["eligible", "queued"] }, batchId: null },
      { $set: { status: "queued", batchId: batch._id }, $push: { history: { status: "queued", at: new Date(), note: batch.batchReference } } },
      { new: true }
    );
    if (!queued) continue;
    await syncSellerOrder(queued, null);
    await enqueue("payout.execute", { payoutId: sid(queued._id) }, `payout.execute:${sid(queued._id)}:batch:${sid(batch._id)}`);
  }
  await enqueue("batch.refresh", { batchId: sid(batch._id) }, `batch.refresh:${sid(batch._id)}`, { runAt: new Date(Date.now() + 30_000) });
  await auditFinance({
    actorId: actor.actorId,
    actorType: "admin",
    action: "payout.batch",
    targetType: "PayoutBatch",
    targetId: batch._id,
    ip: actor.ip,
    meta: { count: rows.length, totalAmount: batch.totalAmount },
  });
  return batch;
}

/** Statut du lot dérivé des résultats individuels — jamais l'inverse. */
export async function refreshPayoutBatch(batchId: string): Promise<JobResult> {
  const batch = await PayoutBatch.findById(batchId);
  if (!batch) return {};
  const rows = await Payout.find({ _id: { $in: batch.payoutIds } }, "payoutReference status failureCode").lean();
  const statuses = rows.map((r) => r.status);
  const ok = statuses.filter((s) => s === "succeeded").length;
  const ko = statuses.filter((s) => s === "failed" || s === "cancelled" || s === "blocked").length;
  const pending = statuses.filter((s) => ["eligible", "queued", "processing"].includes(String(s))).length;
  const unknown = statuses.filter((s) => s === "unknown").length;
  batch.results = rows.map((r) => ({ payoutId: r._id, payoutReference: r.payoutReference, status: r.status, failureCode: r.failureCode })) as any;
  batch.status = (
    pending ? "processing" : unknown ? "unknown" : ok === rows.length ? "completed" : ok > 0 ? "partially_completed" : ko ? "failed" : "processing"
  ) as any;
  if (!pending && !unknown) batch.completedAt = batch.completedAt || new Date();
  await batch.save();
  return pending || unknown ? { reschedule: 60_000 } : {};
}

/**
 * Statut inconnu non résolu automatiquement : l'admin tranche APRÈS contrôle dans le tableau
 * de bord Chap Chap Pay. Action journalisée ; aucune modification de montant possible.
 */
export async function resolveUnknownPayout(payoutId: string, outcome: "succeeded" | "failed", note: string, actor: Actor) {
  const payout = await Payout.findById(payoutId);
  if (!payout) throw notFound("Reversement introuvable");
  if (payout.status !== "unknown" && payout.status !== "processing") {
    throw conflict("NOT_UNKNOWN", "Ce reversement n'est pas en statut inconnu.");
  }
  if (!note || note.trim().length < 10) throw badRequest("NOTE_REQUIRED", "Indique la preuve consultée (référence, capture…).");
  const open = await PayoutAttempt.find({ payoutId, status: { $in: ["created", "processing", "unknown"] } });
  for (const attempt of open) {
    await applyAttemptOutcome(payoutId, attempt._id, {
      status: outcome,
      code: outcome === "failed" ? "MANUAL_NOT_EXECUTED" : undefined,
      message: `Décision admin : ${note}`,
    });
  }
  await auditFinance({
    actorId: actor.actorId,
    actorType: "admin",
    action: "payout.resolve_unknown",
    targetType: "Payout",
    targetId: payoutId,
    severity: "warning",
    ip: actor.ip,
    meta: { outcome, note },
  });
  return Payout.findById(payoutId);
}

export async function setPayoutBlocked(payoutId: string, blocked: boolean, reason: string, actor: Actor) {
  const payout = blocked
    ? await Payout.findOneAndUpdate(
        { _id: payoutId, status: { $in: ["eligible", "queued", "failed"] } },
        { $set: { status: "blocked", failureCode: "ADMIN_HOLD", failureMessage: reason }, $push: { history: { status: "blocked", at: new Date(), note: reason } } },
        { new: true }
      )
    : await Payout.findOneAndUpdate(
        { _id: payoutId, status: "blocked", failureCode: { $in: ["ADMIN_HOLD", "BELOW_MINIMUM"] } },
        {
          $set: { status: env.payoutAutoExecute ? "queued" : "eligible", failureCode: "", failureMessage: "" },
          $push: { history: { status: "unblocked", at: new Date(), note: reason } },
        },
        { new: true }
      );
  if (!payout) throw conflict("STATE", "Ce reversement ne peut pas changer d'état maintenant.");
  await syncSellerOrder(payout, null);
  if (payout.status === "queued") {
    await enqueue("payout.execute", { payoutId }, `payout.execute:${payoutId}:unblock:${Date.now()}`);
  }
  await auditFinance({
    actorId: actor.actorId,
    actorType: "admin",
    action: blocked ? "payout.block" : "payout.unblock",
    targetType: "Payout",
    targetId: payoutId,
    ip: actor.ip,
    meta: { reason },
  });
  return payout;
}

/** Webhook PUSH : localise la tentative et planifie une vérification (jamais d'effet direct). */
export async function schedulePayoutVerificationFromWebhook(requestId: string, orderId: string, eventKey: string) {
  const attempt =
    (requestId && (await PayoutAttempt.findOne({ providerReference: requestId }).lean())) ||
    (orderId && (await PayoutAttempt.findOne({ attemptReference: orderId }).lean()));
  if (!attempt) return null;
  if (requestId && !attempt.providerReference) {
    await PayoutAttempt.updateOne({ _id: attempt._id, providerReference: "" }, { $set: { providerReference: requestId } });
  }
  await enqueue("payout.verify", { payoutId: sid(attempt.payoutId) }, `payout.verify:${sid(attempt.payoutId)}:wh:${eventKey}`);
  return attempt;
}
