/**
 * PaymentService (Chap Chap Pay — E-Commerce / Payment Link).
 *
 * Le client paie UNE fois, sur la page hébergée par Chap Chap Pay. Un webhook ou un retour
 * navigateur n'est jamais une preuve : seul le statut lu via l'API (GET /ecommerce/{operation_id}),
 * avec contrôle de la référence, du montant et de la devise, confirme l'encaissement.
 */
import { env } from "../../config/env.js";
import { Order, Payment } from "../../models/commerce.js";
import { FinancialAllocation, ParentOrder, Refund } from "../../models/finance.js";
import { badGateway, badRequest, notFound } from "../../utils/http-error.js";
import { sid } from "../../utils/ids.js";
import { logger } from "../../utils/logger.js";
import { publicApiOrigin } from "../../utils/public-api.js";
import { ChapChapPayError, paymentProvider, type CcpEcommerceOperation } from "../chapchappay.js";
import { splitPersonName } from "../gn-phone.js";
import { notify } from "../notify.js";
import { afterOrdersPaid, applyPaidToOrders, releaseUnpaidOrders } from "../payments.js";
import { alertFinance, enqueue, opts, recordLedger, withTransaction } from "./core.js";
import { createFinancialStructure, fundAllocations } from "./financial-service.js";
import { paymentFeeGnf } from "./fees.js";
import { createRefundPayout } from "./payout-service.js";

const VERIFY_THROTTLE_MS = 5_000;
/** Annulation explicite ou lien expiré : la commande est close immédiatement. */
const FINAL_UNPAID = new Set(["canceled", "expired"]);
/**
 * Échec d'une tentative (numéro introuvable, solde insuffisant…) : la page Chap Chap Pay laisse
 * le client réessayer sur le même lien. On ne clôt qu'après ce délai sans succès.
 */
const RETRYABLE_UNPAID = new Set(["failed", "error"]);
const RETRY_WINDOW_MS = 30 * 60_000;

export function paymentCallbackUrl() {
  return `${publicApiOrigin()}/api/v1/payments/webhook/chapchappay`;
}

export function paymentReturnUrls(reference: string) {
  const base = `${publicApiOrigin()}/api/v1/payments/return/${encodeURIComponent(reference)}`;
  return { returnUrl: base, cancelUrl: `${base}?cancel=1` };
}

/** Lien de retour vers l'app : seuls les schémas de FripCash / Expo sont acceptés. */
export function safeAppReturnUrl(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value || value.length > 300) return "";
  if (/^(fripcash|exp|exps):\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const allowed = [...env.corsOrigin.split(","), env.appWebUrl].map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    if (url.protocol === "https:" && allowed.includes(url.origin)) return value;
    // App web en développement (expo start --web).
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return env.nodeEnv !== "production" && local && url.protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

type CheckoutInput = {
  orders: any[];
  buyerId: unknown;
  method: "OM_GN" | "MTN_GN" | "CHAPCHAPPAY";
  payPhone: { e164: string; local: string };
  name: string;
  email: string;
  reservedLines: Array<{ listingId: unknown; quantity: number }>;
  appReturnUrl?: string;
};

/**
 * 1) Transaction : ParentOrder + allocations + Payment unique.
 * 2) Hors transaction : création du lien de paiement chez Chap Chap Pay.
 */
export async function startChapChapCheckout(input: CheckoutInput) {
  const amount = input.orders.reduce((s, o) => s + (o.amountGnf || 0) + (o.shippingCostGnf || 0), 0);
  if (amount < env.chapchapMinPaymentGnf) {
    throw badRequest("MIN_PAYMENT", `Le montant minimum de paiement est de ${env.chapchapMinPaymentGnf} GNF.`);
  }
  const paymentFee = paymentFeeGnf(amount, input.method);
  const { payment, orderNumber } = await withTransaction((session) =>
    createFinancialStructure(
      {
        paymentFee,
        orders: input.orders,
        buyerId: input.buyerId,
        paymentMethod: input.method,
        payerPhoneE164: input.payPhone.e164,
        reservedLines: input.reservedLines,
        appReturnUrl: safeAppReturnUrl(input.appReturnUrl),
      },
      session
    )
  );

  const names = splitPersonName(input.name);
  const urls = paymentReturnUrls(orderNumber);
  const jumpTo = input.method === "OM_GN" ? "orange_money" : input.method === "MTN_GN" ? "mtn_momo" : undefined;
  let operation: CcpEcommerceOperation | null = null;
  try {
    operation = await paymentProvider().createEcommerceOperation({
      orderId: orderNumber,
      amountGnf: payment.amountGnf,
      description: `Commande FripCash ${orderNumber}`,
      callbackUrl: paymentCallbackUrl(),
      returnUrl: urls.returnUrl,
      cancelUrl: urls.cancelUrl,
      jumpTo,
      customer: {
        firstname: names.first,
        lastname: names.last,
        email: input.email,
        tel: jumpTo ? input.payPhone.local : undefined,
      },
    });
  } catch (err) {
    // Réponse perdue : l'opération existe peut-être déjà, on la retrouve par notre référence.
    if (err instanceof ChapChapPayError && err.kind === "unknown") {
      operation = await paymentProvider().findEcommerceOperationByOrderId(orderNumber).catch(() => null);
    }
    if (!operation) {
      const fresh = await Payment.findById(payment._id);
      if (fresh) await markUnpaid(fresh, "failed", err instanceof Error ? err.message : "Lien de paiement indisponible");
      logger.warn({ err: String(err), orderNumber }, "ChapChapPay checkout failed");
      throw badGateway("PAYMENT_PROVIDER", "Le paiement est momentanément indisponible. Réessaie dans un instant.");
    }
  }
  if (Math.round(Number(operation.amount)) !== payment.amountGnf) {
    await alertFinance("Montant Chap Chap Pay incohérent", `${orderNumber} : ${operation.amount} ≠ ${payment.amountGnf}`, {
      action: "payment.amount_mismatch",
      targetType: "Payment",
      targetId: payment._id,
      severity: "critical",
    });
    throw badGateway("PAYMENT_AMOUNT", "Montant du lien de paiement incohérent.");
  }
  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        providerOperationId: operation.operation_id,
        paymentUrl: operation.payment_url,
        providerStatus: operation.status?.code || "new",
        message: "Paiement à finaliser sur la page sécurisée Chap Chap Pay.",
      },
    }
  );
  // Filet de sécurité si le webhook se perd.
  await enqueue("payment.verify", { paymentId: sid(payment._id) }, `payment.verify:${sid(payment._id)}:initial`, {
    runAt: new Date(Date.now() + 10 * 60_000),
  });
  return Payment.findById(payment._id);
}

async function markUnpaid(payment: any, providerCode: string, message: string) {
  const status = providerCode === "expired" ? "expired" : providerCode === "canceled" ? "canceled" : "failed";
  // Transition atomique : un seul processus libère le stock.
  const won = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    { $set: { status, providerStatus: providerCode, processedAt: new Date(), message } },
    { new: true }
  );
  if (!won) return;
  await ParentOrder.updateOne(
    { _id: won.parentOrderId },
    { $set: { status: "cancelled", "payment.status": "failed" } }
  );
  const note =
    status === "expired" ? "Lien de paiement expiré" : status === "canceled" ? "Paiement annulé par le client" : "Paiement échoué";
  await releaseUnpaidOrders(won, note);
}

/** Encaissement confirmé : une seule fois, quel que soit le nombre de webhooks reçus. */
async function confirmPaid(paymentId: unknown, operation: CcpEcommerceOperation) {
  const result = await withTransaction(async (session) => {
    const payment = await Payment.findOneAndUpdate(
      { _id: paymentId, status: "pending" },
      {
        $set: {
          status: "success",
          providerStatus: "success",
          paidAt: new Date(),
          processedAt: new Date(),
          providerReference: operation.transaction?.payment_reference || "",
          message: "Paiement confirmé.",
        },
      },
      { new: true, ...opts(session) }
    );
    if (!payment) return null;
    await ParentOrder.updateOne(
      { _id: payment.parentOrderId },
      {
        $set: {
          status: "paid",
          "payment.status": "paid",
          "payment.providerTransactionId": operation.transaction?.payment_reference || operation.operation_id,
        },
      },
      opts(session)
    );
    await fundAllocations(payment.parentOrderId, session);
    await recordLedger(
      {
        entryKey: `payment_confirmed:${payment.merchantTransactionId}`,
        type: "payment_confirmed",
        amount: payment.amountGnf,
        direction: "in",
        parentOrderId: payment.parentOrderId,
        paymentId: payment._id,
        beneficiaryType: "platform",
        reference: operation.operation_id,
        note: operation.transaction?.payment_method || "",
      },
      session
    );
    const orders = await applyPaidToOrders(payment.orderIds, "Paiement Chap Chap Pay confirmé", session);
    return { payment, orders };
  });
  if (result) {
    try {
      await afterOrdersPaid(result.payment, result.orders);
    } catch (err) {
      logger.warn({ err: String(err) }, "post-payment side effects failed");
    }
  }
  return result;
}

/**
 * Succès définitif reçu APRÈS que la commande a été annulée (annulation puis confirmation
 * tardive de l'opérateur) : le client a payé des articles libérés → remboursement automatique.
 */
async function handleLateSuccess(paymentId: unknown, operation: CcpEcommerceOperation) {
  const done = await withTransaction(async (session) => {
    const payment = await Payment.findOneAndUpdate(
      { _id: paymentId, status: { $in: ["failed", "canceled", "expired"] }, requiresReview: false },
      { $set: { status: "success", providerStatus: "success", paidAt: new Date(), requiresReview: true } },
      { new: true, ...opts(session) }
    );
    if (!payment) return null;
    const parent = await ParentOrder.findById(payment.parentOrderId, null, opts(session));
    if (!parent) return null;
    parent.payment!.status = "paid";
    await parent.save(opts(session));
    await recordLedger(
      {
        entryKey: `late_payment_detected:${payment.merchantTransactionId}`,
        type: "late_payment_detected",
        amount: payment.amountGnf,
        direction: "in",
        parentOrderId: parent._id,
        paymentId: payment._id,
        reference: operation.operation_id,
      },
      session
    );
    const allocations = await FinancialAllocation.find({ parentOrderId: parent._id }, null, opts(session));
    for (const a of allocations) {
      a.refundedAmount = a.amount;
      a.status = "refunded";
      a.history.push({ status: "refunded", at: new Date(), note: "Paiement tardif sur commande annulée" });
      await a.save(opts(session));
    }
    const [refund] = await Refund.create(
      [
        {
          refundReference: `${parent.orderNumber}-R-LATE`,
          parentOrderId: parent._id,
          paymentId: payment._id,
          buyerId: payment.buyerId,
          amount: payment.amountGnf,
          reason: "Paiement confirmé après annulation de la commande",
          kind: "late_payment",
          status: "requested",
          allocationAdjustments: allocations.map((a) => ({ allocationId: a._id, beneficiaryType: a.beneficiaryType, amount: a.amount })),
          history: [{ status: "requested", at: new Date(), note: "Remboursement automatique" }],
        },
      ],
      opts(session)
    );
    const order = await Order.findById(payment.orderIds[0], null, opts(session)).lean();
    await createRefundPayout(refund!, order, session);
    return payment;
  });
  if (done) {
    await alertFinance(
      "Paiement tardif remboursé",
      `${done.merchantTransactionId} : paiement confirmé après annulation, remboursement automatique lancé.`,
      { action: "payment.late_success", targetType: "Payment", targetId: done._id }
    );
    if (done.buyerId) {
      await notify(
        sid(done.buyerId),
        "payment",
        "Paiement reçu après annulation",
        "Ta commande avait été annulée avant la confirmation de ton opérateur. Nous te remboursons automatiquement.",
        { paymentId: sid(done._id) }
      ).catch(() => null);
    }
  }
}

/** Vérifie le paiement auprès de l'API Chap Chap Pay et applique le statut canonique. */
export async function verifyChapChapPayment(paymentId: unknown, options: { force?: boolean } = {}) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw notFound("Paiement introuvable");
  if (payment.provider !== "chapchappay") return payment;
  if (payment.status === "success" && !payment.requiresReview) return payment;
  if (!options.force && payment.verifiedAt && Date.now() - payment.verifiedAt.getTime() < VERIFY_THROTTLE_MS) {
    return payment;
  }
  await Payment.updateOne({ _id: payment._id }, { $set: { verifiedAt: new Date() } });

  const operation = payment.providerOperationId
    ? await paymentProvider().getEcommerceOperation(payment.providerOperationId)
    : await paymentProvider().findEcommerceOperationByOrderId(payment.merchantTransactionId);
  if (!operation) return payment;

  if (operation.order_id && operation.order_id !== payment.merchantTransactionId) {
    await alertFinance("Référence de paiement incohérente", `${payment.merchantTransactionId} ≠ ${operation.order_id}`, {
      action: "payment.reference_mismatch",
      targetType: "Payment",
      targetId: payment._id,
      severity: "critical",
    });
    return payment;
  }
  const code = operation.status?.code || "new";
  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        providerStatus: code,
        providerOperationId: payment.providerOperationId || operation.operation_id,
        providerResponse: { status: operation.status, transaction: operation.transaction, amount: operation.amount },
      },
    }
  );

  if (code === "success") {
    const formatted = String(operation.amount_formatted || "");
    if (Math.round(Number(operation.amount)) !== payment.amountGnf || (formatted && !formatted.includes("GNF"))) {
      await alertFinance(
        "Montant encaissé incohérent",
        `${payment.merchantTransactionId} : attendu ${payment.amountGnf} GNF, reçu ${operation.amount} (${formatted}).`,
        { action: "payment.amount_mismatch", targetType: "Payment", targetId: payment._id, severity: "critical" }
      );
      return Payment.findById(payment._id);
    }
    if (payment.status === "pending") await confirmPaid(payment._id, operation);
    else await handleLateSuccess(payment._id, operation);
  } else if (FINAL_UNPAID.has(code) && payment.status === "pending") {
    await markUnpaid(payment, code, operation.status?.description || "Le paiement n'a pas abouti.");
  } else if (RETRYABLE_UNPAID.has(code) && payment.status === "pending") {
    const age = Date.now() - new Date(payment.createdAt as any).getTime();
    const reason = operation.status?.description || "La tentative de paiement a échoué.";
    if (age >= RETRY_WINDOW_MS) {
      await markUnpaid(payment, code, reason);
    } else {
      await Payment.updateOne(
        { _id: payment._id, status: "pending" },
        { $set: { message: /réessayer/i.test(reason) ? reason : `${reason} Tu peux réessayer sur la page de paiement.` } }
      );
    }
  }
  return Payment.findById(payment._id);
}

/** Tâche worker : vérification planifiée (webhook reçu, filet de sécurité, réconciliation). */
export async function runPaymentVerification(paymentId: string) {
  const payment = await verifyChapChapPayment(paymentId, { force: true });
  if (payment?.status === "pending") {
    const age = Date.now() - new Date(payment.createdAt as any).getTime();
    // Lien valable 72 h chez Chap Chap Pay : on revérifie de moins en moins souvent.
    // Pendant la fenêtre de nouvel essai, on repasse juste après son expiration pour clore si besoin.
    if (age < RETRY_WINDOW_MS) return { reschedule: Math.min(5 * 60_000, RETRY_WINDOW_MS - age + 1_000) };
    if (age < 73 * 3_600_000) return { reschedule: age < 3_600_000 ? 5 * 60_000 : 60 * 60_000 };
  }
  return {};
}
