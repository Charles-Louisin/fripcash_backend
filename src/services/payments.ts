import mongoose from "mongoose";
import { Cart, Order, Payment } from "../models/commerce.js";
import { Listing } from "../models/listing.js";
import { User } from "../models/user.js";
import { badRequest, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { notifyOrderParties } from "./notify.js";
import {
  cinetpayNotifyUrl,
  getCinetPayPayment,
  getCinetPayTransfer,
  initCinetPayTransfer,
  isFinalFailure,
  isFinalSuccess,
  mapCinetPayMessage,
  notifyTokensMatch,
  type CinetPayApiResult,
  type CinetPayMethod,
} from "./cinetpay.js";
import { parseGnMobile, type GnOperator } from "./gn-phone.js";

export const MIN_TRANSFER_GNF = 500;
export const MIN_PAYMENT_GNF = MIN_TRANSFER_GNF;

function newMerchantId() {
  return `fc${new mongoose.Types.ObjectId().toString()}`;
}

function orderNet(row: { items: any[] }) {
  return row.items.reduce((s, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1), 0);
}

export function serializePayment(doc: any) {
  return {
    id: sid(doc._id),
    merchantTransactionId: doc.merchantTransactionId,
    status: doc.status,
    kind: doc.kind,
    paymentMethod: doc.paymentMethod,
    amountGnf: doc.amountGnf,
    message: doc.message || "",
    paymentUrl: doc.paymentUrl || "",
    orderIds: (doc.orderIds || []).map((id: unknown) => sid(id)),
  };
}

export async function restoreReservedStock(
  lines: Array<{ listingId: unknown; quantity: number }>
) {
  for (const line of lines) {
    const listing = await Listing.findById(line.listingId);
    if (!listing) continue;
    listing.quantity += line.quantity;
    if (listing.status === "SOLD_OUT" && listing.quantity > 0) {
      listing.status = "ACTIVE";
    }
    await listing.save();
  }
}

function applyCinetPayIds(payment: any, result: CinetPayApiResult) {
  if (result.transactionId) payment.cinetpayTransactionId = result.transactionId;
  if (result.notifyToken) payment.notifyToken = result.notifyToken;
  if (result.paymentUrl) payment.paymentUrl = result.paymentUrl;
  payment.message = result.message;
}

function mapInboundStatus(result: CinetPayApiResult): "pending" | "success" | "failed" | "expired" {
  if (isFinalSuccess(result.status)) return "success";
  if (result.status === "EXPIRED") return "expired";
  if (isFinalFailure(result.status)) return "failed";
  return "pending";
}

export async function settleInboundPayment(payment: any, result: CinetPayApiResult) {
  applyCinetPayIds(payment, result);
  const next = mapInboundStatus(result);
  if (payment.status === "success" || payment.status === "failed" || payment.status === "expired") {
    await payment.save();
    return payment;
  }

  if (next === "success") {
    payment.status = "success";
    payment.processedAt = new Date();
    await payment.save();
    const orders = await Order.find({ _id: { $in: payment.orderIds } });
    for (const order of orders) {
      if (order.status !== "ORDERED" && order.escrowStatus !== "pending") continue;
      if (order.escrowStatus !== "held") {
        order.escrowStatus = "held";
      }
      order.status = "SELLER_NOTIFIED";
      order.timeline.push(
        { status: "PAID", at: new Date(), note: "Paiement CinetPay confirmé — fonds en séquestre" },
        { status: "SELLER_NOTIFIED", at: new Date() }
      );
      await order.save();
      await notifyOrderParties(order, "SELLER_NOTIFIED");
    }
    if (payment.buyerId) {
      await Cart.findOneAndUpdate({ userId: payment.buyerId }, { items: [] });
    }
    return payment;
  }

  if (next === "failed" || next === "expired") {
    payment.status = next;
    payment.processedAt = new Date();
    await payment.save();
    await restoreReservedStock(payment.reservedLines || []);
    payment.reservedLines = [];
    await payment.save();
    const orders = await Order.find({ _id: { $in: payment.orderIds } });
    for (const order of orders) {
      if (order.status !== "ORDERED") continue;
      order.status = "REFUNDED";
      order.escrowStatus = "refunded";
      order.timeline.push({
        status: "REFUNDED",
        at: new Date(),
        note: next === "expired" ? "Paiement expiré" : "Paiement échoué",
      });
      await order.save();
    }
  } else {
    payment.status = "pending";
    await payment.save();
  }
  return payment;
}

async function settleOutbound(payment: any, result: CinetPayApiResult) {
  applyCinetPayIds(payment, result);
  const next = mapInboundStatus(result);
  if (payment.status === "success" || payment.status === "failed" || payment.status === "expired") {
    await payment.save();
    return payment;
  }

  if (next === "pending") {
    payment.status = "pending";
    await payment.save();
    return payment;
  }

  if (next !== "success") {
    payment.status = next === "expired" ? "expired" : "failed";
    payment.processedAt = new Date();
    await payment.save();
    if (payment.kind === "payout" || payment.kind === "refund") {
      const orders = await Order.find({ _id: { $in: payment.orderIds } });
      for (const order of orders) {
        if (order.escrowStatus === "payout_pending" || order.escrowStatus === "refund_pending") {
          order.escrowStatus = "held";
          order.timeline.push({
            status: order.status,
            at: new Date(),
            note: "Transfert CinetPay échoué — séquestre toujours bloqué",
          });
          await order.save();
        }
      }
    }
    return payment;
  }

  payment.status = "success";
  payment.processedAt = new Date();
  await payment.save();

  if (payment.kind === "withdrawal" || payment.kind === "delivery" || payment.kind === "split") {
    return payment;
  }

  const orders = await Order.find({ _id: { $in: payment.orderIds } });
  for (const order of orders) {
    if (payment.kind === "payout") {
      order.escrowStatus = "released";
      order.status = "FUNDS_RELEASED";
      order.timeline.push({
        status: "FUNDS_RELEASED",
        at: new Date(),
        note: "Fonds transférés au vendeur via CinetPay",
      });
      await order.save();
      await notifyOrderParties(order, "FUNDS_RELEASED", "Les fonds ont été libérés");
    }
    if (payment.kind === "refund") {
      order.escrowStatus = "refunded";
      order.status = "REFUNDED";
      order.timeline.push({
        status: "REFUNDED",
        at: new Date(),
        note: "Remboursement transféré à l'acheteur via CinetPay",
      });
      await order.save();
      await notifyOrderParties(order, "REFUNDED", "Remboursement effectué");
    }
  }
  return payment;
}

export async function refreshPayment(merchantTransactionId: string) {
  const payment = await Payment.findOne({ merchantTransactionId });
  if (!payment) throw notFound("Paiement introuvable");
  if (payment.kind === "payment") {
    const result = await getCinetPayPayment(merchantTransactionId);
    return settleInboundPayment(payment, result);
  }
  const txId = payment.cinetpayTransactionId || merchantTransactionId;
  const result = await getCinetPayTransfer(txId);
  return settleOutbound(payment, result);
}

export async function handleCinetPayNotify(payload: {
  notify_token?: string;
  merchant_transaction_id?: string;
  transaction_id?: string;
}) {
  const merchantId = String(payload.merchant_transaction_id || "");
  const txId = String(payload.transaction_id || "");
  if (!merchantId && !txId) {
    throw badRequest("NOTIFY", "Notification incomplète");
  }
  const payment = merchantId
    ? await Payment.findOne({ merchantTransactionId: merchantId })
    : await Payment.findOne({ cinetpayTransactionId: txId });
  if (!payment) {
    logger.warn({ merchantId }, "CinetPay notify for unknown payment");
    return;
  }
  if (txId && payment.lastNotifyTransactionId === txId && payment.processedAt) {
    return;
  }
  if (payment.notifyToken && payload.notify_token) {
    if (!notifyTokensMatch(payment.notifyToken, String(payload.notify_token))) {
      throw badRequest("NOTIFY_TOKEN", "Jeton de notification invalide");
    }
  }
  if (txId) payment.lastNotifyTransactionId = txId;

  if (payment.kind === "payment") {
    const canonical = await getCinetPayPayment(payment.merchantTransactionId);
    if (canonical.amount != null && Number(canonical.amount) !== payment.amountGnf) {
      logger.warn(
        { merchantId: payment.merchantTransactionId, expected: payment.amountGnf, got: canonical.amount },
        "CinetPay amount mismatch"
      );
      throw badRequest("AMOUNT", "Montant CinetPay incohérent");
    }
    await settleInboundPayment(payment, canonical);
    return;
  }

  const lookupId = payment.cinetpayTransactionId || txId;
  if (!lookupId) return;
  const canonical = await getCinetPayTransfer(lookupId);
  await settleOutbound(payment, canonical);
}

function sellerPayoutPhone(seller: any): { e164: string; operator: GnOperator } {
  const candidates = [seller?.seller?.orangeMoneyPhone, seller?.phone].filter(Boolean);
  for (const value of candidates) {
    const parsed = parseGnMobile(String(value));
    if (parsed) return parsed;
  }
  throw badRequest(
    "PAYOUT_PHONE",
    "Le vendeur n'a pas de numéro Mobile Money guinéen (Orange 62 ou MTN 65)."
  );
}

async function startTransfer(input: {
  kind: "payout" | "refund" | "withdrawal" | "delivery" | "split";
  amountGnf: number;
  method: GnOperator;
  phoneE164: string;
  reason: string;
  orderIds?: string[];
  userId?: string;
  buyerId?: string;
}) {
  const merchantTransactionId = newMerchantId();
  const payment = await Payment.create({
    merchantTransactionId,
    kind: input.kind,
    status: "pending",
    paymentMethod: input.method,
    amountGnf: input.amountGnf,
    phoneE164: input.phoneE164,
    orderIds: input.orderIds || [],
    userId: input.userId || null,
    buyerId: input.buyerId || null,
  });
  try {
    const result = await initCinetPayTransfer({
      merchantTransactionId,
      amountGnf: input.amountGnf,
      method: input.method,
      phoneE164: input.phoneE164,
      reason: input.reason,
      notifyUrl: cinetpayNotifyUrl(),
    });
    applyCinetPayIds(payment, result);
    await payment.save();
    if (isFinalFailure(result.status) && result.status !== "PENDING") {
      await settleOutbound(payment, result);
      throw badRequest(result.status, result.message);
    }
    if (isFinalSuccess(result.status)) {
      await settleOutbound(payment, result);
    } else {
      payment.status = "pending";
      await payment.save();
    }
    return payment;
  } catch (err) {
    if (payment.status === "pending") {
      await settleOutbound(payment, {
        code: 2010,
        status: "FAILED",
        message: err instanceof Error ? err.message : mapCinetPayMessage("FAILED"),
        mustRedirect: false,
        raw: {},
      });
    }
    throw err;
  }
}

export async function payoutOrderToSeller(
  order: any,
  amountGnf: number,
  reason: string,
  _opts: { finalize?: boolean } = {}
) {
  if (order.escrowStatus === "released") return { mode: "already" as const };
  if (order.escrowStatus === "payout_pending" && order.payoutMerchantId) {
    const existing = await refreshPayment(order.payoutMerchantId);
    return { mode: "cinetpay" as const, payment: existing };
  }
  if (order.escrowStatus !== "held" && order.escrowStatus !== "payout_pending") {
    throw badRequest("ESCROW", "Séquestre déjà clôturé");
  }
  const amount = Math.round(amountGnf);
  if (amount < MIN_TRANSFER_GNF) {
    throw badRequest(
      "MIN_TRANSFER",
      `Le versement Mobile Money minimum est de ${MIN_TRANSFER_GNF} GNF. Les fonds restent en séquestre.`
    );
  }
  const seller = await User.findById(order.sellerId);
  if (!seller) throw notFound("Vendeur introuvable");
  const dest = sellerPayoutPhone(seller);
  order.escrowStatus = "payout_pending";
  await order.save();
  const payment = await startTransfer({
    kind: "payout",
    amountGnf: amount,
    method: dest.operator,
    phoneE164: dest.e164,
    reason,
    orderIds: [sid(order._id)],
    buyerId: sid(order.buyerId),
  });
  order.payoutMerchantId = payment.merchantTransactionId;
  await order.save();
  return { mode: "cinetpay" as const, payment };
}

export async function refundOrderToBuyer(
  order: any,
  amountGnf: number,
  reason: string,
  opts: { finalize?: boolean } = {}
) {
  const finalize = opts.finalize !== false;
  if (order.escrowStatus === "refunded") return { mode: "already" as const };
  if (order.escrowStatus === "refund_pending" && order.payoutMerchantId) {
    const existing = await refreshPayment(order.payoutMerchantId);
    return { mode: "cinetpay" as const, payment: existing };
  }
  if (order.escrowStatus !== "held" && order.escrowStatus !== "refund_pending") {
    throw badRequest("ESCROW", "Séquestre déjà clôturé");
  }
  const amount = Math.round(amountGnf);
  const inbound = order.paymentMerchantId
    ? await Payment.findOne({ merchantTransactionId: order.paymentMerchantId, kind: "payment" })
    : await Payment.findOne({ orderIds: order._id, kind: "payment" });
  const phone = inbound?.phoneE164 || order.address?.paymentPhone || order.address?.phone;
  const parsed = phone ? parseGnMobile(String(phone)) : null;

  if (!parsed) {
    throw badRequest(
      "PAYOUT_PHONE",
      "Remboursement impossible : le numéro Mobile Money du paiement est manquant. Les fonds restent en séquestre."
    );
  }
  if (amount < MIN_TRANSFER_GNF) {
    throw badRequest(
      "MIN_TRANSFER",
      `Le remboursement Mobile Money minimum est de ${MIN_TRANSFER_GNF} GNF. Les fonds restent en séquestre.`
    );
  }

  if (finalize) order.escrowStatus = "refund_pending";
  await order.save();
  const payment = await startTransfer({
    kind: "refund",
    amountGnf: amount,
    method: parsed.operator,
    phoneE164: parsed.e164,
    reason,
    orderIds: [sid(order._id)],
    buyerId: sid(order.buyerId),
  });
  order.payoutMerchantId = payment.merchantTransactionId;
  await order.save();
  return { mode: "cinetpay" as const, payment };
}

export async function splitEscrow(order: any, buyerAmt: number, sellerAmt: number) {
  if (order.escrowStatus !== "held") {
    throw badRequest("ESCROW", "Séquestre déjà clôturé");
  }
  const buyer = Math.round(buyerAmt);
  const sellerAmtRounded = Math.round(sellerAmt);
  if ((buyer > 0 && buyer < MIN_TRANSFER_GNF) || (sellerAmtRounded > 0 && sellerAmtRounded < MIN_TRANSFER_GNF)) {
    throw badRequest(
      "MIN_TRANSFER",
      `Chaque part versée doit atteindre ${MIN_TRANSFER_GNF} GNF. Les fonds restent en séquestre.`
    );
  }
  if (buyer > 0) {
    const inbound = order.paymentMerchantId
      ? await Payment.findOne({ merchantTransactionId: order.paymentMerchantId, kind: "payment" })
      : await Payment.findOne({ orderIds: order._id, kind: "payment" });
    const phone = inbound?.phoneE164 || order.address?.paymentPhone || order.address?.phone;
    const parsed = phone ? parseGnMobile(String(phone)) : null;
    if (!parsed) {
      throw badRequest("PAYOUT_PHONE", "Numéro Mobile Money de l'acheteur manquant.");
    }
    await startTransfer({
      kind: "split",
      amountGnf: buyer,
      method: parsed.operator,
      phoneE164: parsed.e164,
      reason: "Litige — part acheteur",
      orderIds: [sid(order._id)],
      buyerId: sid(order.buyerId),
    });
  }
  if (sellerAmtRounded > 0) {
    const seller = await User.findById(order.sellerId);
    if (!seller) throw notFound("Vendeur introuvable");
    const dest = sellerPayoutPhone(seller);
    await startTransfer({
      kind: "split",
      amountGnf: sellerAmtRounded,
      method: dest.operator,
      phoneE164: dest.e164,
      reason: "Litige — part vendeur",
      orderIds: [sid(order._id)],
      buyerId: sid(order.buyerId),
    });
  }
  order.status = "FUNDS_RELEASED";
  order.escrowStatus = "released";
  order.timeline.push({
    status: "FUNDS_RELEASED",
    at: new Date(),
    note: "Litige partagé — versements Mobile Money",
  });
  await order.save();
}

export async function payCourierDeliveryFee(order: any, courier: { _id: unknown; phone?: string | null }) {
  const fee = Math.round(Math.max(0, order.shippingCostGnf || 0));
  if (fee <= 0) return null;
  const existing = await Payment.findOne({
    orderIds: order._id,
    kind: "delivery",
    status: { $in: ["pending", "success"] },
  });
  if (existing) return existing;
  const parsed = courier.phone ? parseGnMobile(String(courier.phone)) : null;
  if (!parsed || fee < MIN_TRANSFER_GNF) {
    order.timeline.push({
      status: order.status,
      at: new Date(),
      note: !parsed
        ? "Frais de livraison non versés : numéro Mobile Money du livreur manquant"
        : `Frais de livraison non versés : minimum CinetPay ${MIN_TRANSFER_GNF} GNF`,
    });
    return null;
  }
  return startTransfer({
    kind: "delivery",
    amountGnf: fee,
    method: parsed.operator,
    phoneE164: parsed.e164,
    reason: "Frais de livraison FripCash",
    orderIds: [sid(order._id)],
    userId: sid(courier._id),
  });
}

export async function withdrawToMobile(_userId: string, _amountGnf: number, _phone: string) {
  throw badRequest(
    "NO_WALLET",
    "FripCash ne gère pas de portefeuille interne. Les fonds partent directement vers Mobile Money."
  );
}

export function paymentPublicView(payment: any, extra?: { mustRedirect?: boolean }) {
  return {
    ...serializePayment(payment),
    mustRedirect: Boolean(extra?.mustRedirect && payment.paymentUrl),
  };
}

export type CheckoutMethod = CinetPayMethod;
