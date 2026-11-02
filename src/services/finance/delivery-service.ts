/**
 * DeliveryService : confirmations de réception et de livraison.
 * Ces fonctions ne transfèrent JAMAIS d'argent : elles rendent une allocation éligible et
 * créent son Payout ; le worker l'exécute ensuite, indépendamment des autres bénéficiaires.
 */
import { Order } from "../../models/commerce.js";
import { Dispute } from "../../models/ops.js";
import { Delivery, FinancialAllocation, ParentOrder } from "../../models/finance.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { sid } from "../../utils/ids.js";
import { logger } from "../../utils/logger.js";
import { auditFinance, opts, withTransaction } from "./core.js";
import {
  courierAllocationFor,
  createSellerOrderRefund,
  holdSellerOrderFunds,
  markAllocationEligible,
  refreshParentOrderStatus,
  releaseSellerOrderHold,
  sellerAllocationFor,
} from "./financial-service.js";

export function isFinancialOrder(order: { parentOrderId?: unknown } | null | undefined) {
  return Boolean(order?.parentOrderId);
}

/** Encaissé : un remboursement partiel (autre vendeur) ne doit pas bloquer les sommes restantes. */
function isFunded(parent: { payment?: { status?: string | null } | null } | null) {
  return parent?.payment?.status === "paid" || parent?.payment?.status === "partially_refunded";
}

type ReceiptActor = { userId: string; role: "buyer" | "admin" | "seller_code" };

/**
 * Réception confirmée d'UNE sous-commande : seule l'allocation de ce vendeur devient éligible.
 * Les autres sous-commandes du ParentOrder ne sont ni attendues ni touchées.
 */
export async function confirmSellerOrderReceipt(sellerOrderId: unknown, actor: ReceiptActor) {
  const order = await Order.findById(sellerOrderId);
  if (!order) throw notFound("Sous-commande introuvable");
  if (!order.parentOrderId) throw badRequest("NOT_FINANCIAL", "Commande hors du système financier.");
  if (actor.role === "buyer" && sid(order.buyerId) !== actor.userId) throw forbidden();

  const parent = await ParentOrder.findById(order.parentOrderId).lean();
  if (!isFunded(parent)) {
    throw conflict("NOT_PAID", "Le paiement de cette commande n'est pas confirmé.");
  }
  const dispute = await Dispute.exists({ orderId: order._id, status: { $in: ["open", "under_review", "closed"] } });
  if (dispute && actor.role !== "admin") {
    // Litige ouvert : la réception est notée mais l'argent reste bloqué.
    return { eligible: false, reason: "DISPUTE" as const };
  }

  const result = await withTransaction(async (session) => {
    const allocation = await sellerAllocationFor(order._id, session);
    if (!allocation) throw notFound("Allocation vendeur introuvable");
    const out = await markAllocationEligible(allocation._id, `Réception confirmée (${actor.role})`, session);
    await auditFinance(
      {
        actorId: actor.role === "seller_code" ? null : actor.userId,
        actorType: actor.role === "admin" ? "admin" : actor.role === "seller_code" ? "seller" : "buyer",
        action: "seller_order.receipt_confirmed",
        targetType: "Order",
        targetId: order._id,
        meta: { allocationStatus: out.allocation.status, payoutId: out.payout ? sid(out.payout._id) : null },
      },
      session
    );
    return out;
  });
  await refreshParentOrderStatus(order.parentOrderId).catch((err) =>
    logger.warn({ err: String(err) }, "parent status refresh failed")
  );
  return { eligible: Boolean(result.payout), payout: result.payout, allocation: result.allocation };
}

/** Affectation (ou transfert) du livreur : le bénéficiaire de l'allocation livreur suit. */
export async function assignCourier(sellerOrderId: unknown, courierId: unknown) {
  const order = await Order.findById(sellerOrderId, "deliveryId parentOrderId").lean();
  if (!order?.deliveryId) return null;
  return withTransaction(async (session) => {
    const delivery = await Delivery.findById(order.deliveryId, null, opts(session));
    if (!delivery) return null;
    if (delivery.status === "confirmed") return delivery;
    delivery.courierId = courierId as any;
    if (delivery.status === "awaiting_courier") delivery.status = "assigned";
    delivery.history.push({ status: delivery.status, at: new Date(), note: `Livreur ${sid(courierId)}` });
    await delivery.save(opts(session));
    await FinancialAllocation.updateOne(
      { deliveryId: delivery._id, beneficiaryType: "courier", status: { $in: ["awaiting_payment", "funded"] } },
      { $set: { beneficiaryId: courierId } },
      opts(session)
    );
    return delivery;
  });
}

/** Livreur rappelé par le vendeur avant la collecte : la livraison et sa rémunération sont libérées. */
export async function unassignCourier(sellerOrderId: unknown) {
  const order = await Order.findById(sellerOrderId, "deliveryId").lean();
  if (!order?.deliveryId) return null;
  return withTransaction(async (session) => {
    const delivery = await Delivery.findOneAndUpdate(
      { _id: order.deliveryId, status: { $in: ["assigned", "accepted"] } },
      {
        $set: { courierId: null, status: "awaiting_courier" },
        $push: { history: { status: "awaiting_courier", at: new Date(), note: "Livreur rappelé par le vendeur" } },
      },
      { new: true, ...opts(session) }
    );
    if (delivery) {
      await FinancialAllocation.updateOne(
        { deliveryId: delivery._id, beneficiaryType: "courier", status: { $in: ["awaiting_payment", "funded"] } },
        { $set: { beneficiaryId: null } },
        opts(session)
      );
    }
    return delivery;
  });
}

export async function updateDeliveryProgress(sellerOrderId: unknown, status: "picked_up" | "in_transit" | "delivered") {
  const order = await Order.findById(sellerOrderId, "deliveryId").lean();
  if (!order?.deliveryId) return;
  await Delivery.updateOne(
    { _id: order.deliveryId, status: { $nin: ["confirmed", "failed"] } },
    { $set: { status }, $push: { history: { status, at: new Date(), note: "" } } }
  );
}

/**
 * Prestation de livraison confirmée par le CLIENT (ou l'admin), jamais par le livreur seul.
 * Une livraison = une rémunération, même si elle regroupe plusieurs sous-commandes.
 */
export async function confirmDelivery(
  deliveryId: unknown,
  confirmation: { method: "buyer_confirmation" | "admin_validation" | "otp"; by: string }
) {
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery) throw notFound("Livraison introuvable");
  const parent = await ParentOrder.findById(delivery.parentOrderId).lean();
  if (!isFunded(parent)) throw conflict("NOT_PAID", "Paiement non confirmé.");
  if (!delivery.courierId) throw badRequest("NO_COURIER", "Aucun livreur n'a effectué cette livraison.");
  if (confirmation.by && sid(delivery.courierId) === confirmation.by) {
    throw forbidden("SELF_CONFIRMATION", "Le livreur ne peut pas confirmer sa propre livraison.");
  }
  return withTransaction(async (session) => {
    const fresh = await Delivery.findById(deliveryId, null, opts(session));
    if (!fresh) throw notFound("Livraison introuvable");
    if (fresh.status !== "confirmed") {
      fresh.status = "confirmed";
      fresh.confirmation = { method: confirmation.method, confirmedAt: new Date(), confirmedBy: confirmation.by as any };
      fresh.history.push({ status: "confirmed", at: new Date(), note: confirmation.method });
      await fresh.save(opts(session));
    }
    const allocation = await courierAllocationFor(fresh._id, session);
    if (!allocation) return { delivery: fresh, payout: null };
    if (!allocation.beneficiaryId) {
      allocation.beneficiaryId = fresh.courierId;
      await allocation.save(opts(session));
    }
    const out = await markAllocationEligible(allocation._id, `Livraison confirmée (${confirmation.method})`, session);
    await auditFinance(
      {
        actorId: confirmation.by || null,
        actorType: confirmation.method === "admin_validation" ? "admin" : "buyer",
        action: "delivery.confirmed",
        targetType: "Delivery",
        targetId: fresh._id,
        meta: { payoutId: out.payout ? sid(out.payout._id) : null },
      },
      session
    );
    return { delivery: fresh, payout: out.payout };
  });
}

// ─── Litiges ─────────────────────────────────────────────────────────────────

export async function holdForDispute(sellerOrderId: unknown, disputeId: unknown, reason: string) {
  return withTransaction((session) => holdSellerOrderFunds(sellerOrderId, disputeId, reason, session));
}

/**
 * Décision de litige pour une commande du système financier :
 *  - refund_buyer   : remboursement intégral (opération Refund distincte) ;
 *  - release_seller : déblocage et éligibilité du vendeur ;
 *  - partial_refund : part acheteur remboursée, reste dû au vendeur.
 */
export async function resolveFinancialDispute(
  order: any,
  outcome: "refund_buyer" | "release_seller" | "partial_refund",
  opts2: { buyerPercent: number; actorId: string; disputeId: unknown }
) {
  const ratio = outcome === "refund_buyer" ? 1 : outcome === "release_seller" ? 0 : opts2.buyerPercent / 100;
  await withTransaction(async (session) => {
    if (ratio > 0) {
      await createSellerOrderRefund(
        {
          sellerOrderId: order._id,
          ratio,
          reason: outcome === "refund_buyer" ? "Litige — remboursement acheteur" : `Litige — ${opts2.buyerPercent} % acheteur`,
          actorId: opts2.actorId,
          disputeId: opts2.disputeId,
        },
        session
      );
    }
    await releaseSellerOrderHold(order._id, `Litige tranché (${outcome})`, session);
  });
  if (ratio < 1) {
    const allocation = await sellerAllocationFor(order._id, null);
    if (allocation?.status === "funded") {
      await withTransaction((session) => markAllocationEligible(allocation._id, `Litige tranché (${outcome})`, session));
    }
  }
  await refreshParentOrderStatus(order.parentOrderId);
}

/** Remboursement hors litige (vendeur qui annule, offre refusée…). */
export async function refundSellerOrder(sellerOrderId: unknown, reason: string, actorId: string) {
  const refund = await withTransaction((session) =>
    createSellerOrderRefund({ sellerOrderId, ratio: 1, reason, actorId }, session)
  );
  const order = await Order.findById(sellerOrderId, "parentOrderId").lean();
  if (order?.parentOrderId) await refreshParentOrderStatus(order.parentOrderId);
  return refund;
}
