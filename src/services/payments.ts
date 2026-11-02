import mongoose from "mongoose";
import { Cart, Order, Payment } from "../models/commerce.js";
import { Offer } from "../models/social.js";
import { Listing } from "../models/listing.js";
import { conflict, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { notify, notifyOrderParties } from "./notify.js";
import { randomDigits } from "../utils/pricing.js";

const PICKUP_ACTIVE_STATUSES = [
  "PAID",
  "SELLER_NOTIFIED",
  "PREPARING",
  "READY_FOR_PICKUP",
  "COURIER_ASSIGNED",
  "COLLECTED",
  "IN_TRANSIT",
  "DELIVERED",
];

/**
 * Commande antérieure au système financier Chap Chap Pay (sans ParentOrder) :
 * aucun transfert automatique possible, l'équipe la solde manuellement.
 */
export function legacyOrderError() {
  return conflict(
    "LEGACY_ORDER",
    "Commande antérieure au paiement Chap Chap Pay : le règlement est traité manuellement par l'équipe FripCash."
  );
}

/** Code de retrait à 6 chiffres, distinct des codes actifs des autres commandes du même acheteur. */
async function generatePickupCode(order: any) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomDigits(6);
    const clash = await Order.exists({
      _id: { $ne: order._id },
      buyerId: order.buyerId,
      pickupCode: code,
      status: { $in: PICKUP_ACTIVE_STATUSES },
    });
    if (!clash) return code;
  }
  return randomDigits(6);
}

export function serializePayment(doc: any) {
  return {
    id: sid(doc._id),
    merchantTransactionId: doc.merchantTransactionId,
    status: doc.status,
    kind: doc.kind,
    paymentMethod: doc.paymentMethod,
    amountGnf: doc.amountGnf,
    paymentFeeGnf: doc.paymentFeeGnf || 0,
    message: doc.message || "",
    paymentUrl: doc.paymentUrl || "",
    orderIds: (doc.orderIds || []).map((id: unknown) => sid(id)),
    provider: doc.provider || null,
    parentOrderId: doc.parentOrderId ? sid(doc.parentOrderId) : null,
    orderNumber: doc.provider === "chapchappay" ? doc.merchantTransactionId : null,
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

/** Passe les commandes en « payées » (mutations seules, sans notification). */
export async function applyPaidToOrders(orderIds: unknown[], note: string, session: mongoose.ClientSession | null = null) {
  const orders = await Order.find({ _id: { $in: orderIds } }, null, session ? { session } : {});
  const changed: any[] = [];
  for (const order of orders) {
    if (order.status !== "ORDERED" && order.escrowStatus !== "pending") continue;
    order.escrowStatus = "held";
    order.status = "SELLER_NOTIFIED";
    if (order.fulfillmentMode === "pickup" && !order.pickupCode) {
      order.pickupCode = await generatePickupCode(order);
      order.pickupCodeAttempts = 0;
    }
    order.timeline.push({ status: "PAID", at: new Date(), note }, { status: "SELLER_NOTIFIED", at: new Date() });
    await order.save(session ? { session } : {});
    changed.push(order);
  }
  return changed;
}

/** Effets de bord après paiement (hors transaction) : notifications, panier, stock. */
export async function afterOrdersPaid(payment: any, orders: any[]) {
  for (const order of orders) {
    await notifyOrderParties(order, "SELLER_NOTIFIED");
    if (order.pickupCode) {
      await notify(
        sid(order.buyerId),
        "order",
        "Code de retrait",
        `Commande payée. Ton code de retrait : ${order.pickupCode}. Présente-le au vendeur pour récupérer ton colis.`,
        { orderId: sid(order._id), status: "SELLER_NOTIFIED" }
      );
    }
  }
  await warnSellersAboutStock(payment.reservedLines || []);
  if (payment.buyerId) {
    await Cart.findOneAndUpdate({ userId: payment.buyerId }, { items: [] });
  }
}

/** Paiement non abouti : rend le stock et clôt les commandes encore en attente. */
export async function releaseUnpaidOrders(payment: any, note: string) {
  await restoreReservedStock(payment.reservedLines || []);
  payment.reservedLines = [];
  await payment.save();
  await Offer.updateMany({ orderId: { $in: payment.orderIds } }, { orderId: null });
  const orders = await Order.find({ _id: { $in: payment.orderIds } });
  for (const order of orders) {
    if (order.status !== "ORDERED") continue;
    order.status = "REFUNDED";
    order.escrowStatus = "refunded";
    order.timeline.push({ status: "REFUNDED", at: new Date(), note });
    await order.save();
  }
}

const LOW_STOCK = 2;

async function warnSellersAboutStock(lines: Array<{ listingId: unknown }>) {
  for (const line of lines) {
    const listing = await Listing.findById(line.listingId).select("title quantity status sellerId").lean();
    if (!listing?.sellerId) continue;
    const data = { listingId: sid(listing._id), stock: listing.quantity };
    try {
      if (listing.quantity <= 0) {
        await notify(
          sid(listing.sellerId),
          "listing",
          "Article épuisé",
          `« ${listing.title} » n'a plus de stock. Il n'est plus commandable : augmente le stock pour le remettre en vente.`,
          data
        );
      } else if (listing.quantity <= LOW_STOCK) {
        await notify(
          sid(listing.sellerId),
          "listing",
          "Stock faible",
          `Il ne reste que ${listing.quantity} « ${listing.title} » en stock.`,
          data
        );
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "stock warning failed");
    }
  }
}

/** Revérifie un paiement en attente auprès de Chap Chap Pay. Les anciens paiements sont figés. */
export async function refreshPayment(merchantTransactionId: string) {
  const payment = await Payment.findOne({ merchantTransactionId });
  if (!payment) throw notFound("Paiement introuvable");
  if (payment.provider !== "chapchappay") return payment;
  const { verifyChapChapPayment } = await import("./finance/payment-service.js");
  return verifyChapChapPayment(payment._id);
}

export function paymentPublicView(payment: any, extra?: { mustRedirect?: boolean }) {
  return {
    ...serializePayment(payment),
    mustRedirect: Boolean(extra?.mustRedirect && payment.paymentUrl),
  };
}
