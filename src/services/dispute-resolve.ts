import { badRequest } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { notify, notifyAdmins } from "./notify.js";
import { payoutOrderToSeller, refundOrderToBuyer, splitEscrow } from "./payments.js";

export type DisputeOutcome = "refund_buyer" | "release_seller" | "partial_refund";
export type DisputeActor = "admin" | "buyer" | "seller";

export function normalizeOutcome(raw: unknown): DisputeOutcome {
  const value = String(raw || "");
  if (value === "refund_buyer" || value === "resolved_buyer") return "refund_buyer";
  if (value === "partial_refund" || value === "split") return "partial_refund";
  if (value === "release_seller" || value === "resolved_seller") return "release_seller";
  throw badRequest("BAD_OUTCOME", "Décision de litige inconnue.");
}

const ACTOR_LABEL: Record<DisputeActor, string> = {
  admin: "L'équipe FripCash",
  buyer: "L'acheteur",
  seller: "Le vendeur",
};

function orderNet(order: any) {
  return (order.items || []).reduce(
    (s: number, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1),
    0
  );
}

function decisionCopy(outcome: DisputeOutcome, actor: DisputeActor, buyerPercent: number) {
  const who = ACTOR_LABEL[actor];
  if (outcome === "refund_buyer") {
    return {
      title: "Litige résolu : acheteur remboursé",
      body: `${who} a validé le remboursement de l'acheteur.`,
    };
  }
  if (outcome === "release_seller") {
    return {
      title: "Litige résolu : vendeur payé",
      body: `${who} a validé le paiement du vendeur.`,
    };
  }
  return {
    title: "Litige résolu : montant partagé",
    body: `${who} a partagé le montant : ${buyerPercent} % pour l'acheteur, ${100 - buyerPercent} % pour le vendeur.`,
  };
}

/**
 * Tranche un litige : déplace l'argent du séquestre, clôt le litige,
 * poste la décision dans le fil et prévient tout le monde.
 */
export async function resolveDispute(
  d: any,
  order: any,
  outcome: DisputeOutcome,
  opts: { actor: DisputeActor; actorId: string; buyerPercent?: number; note?: string }
) {
  if (d.status === "resolved") {
    throw badRequest("ALREADY_RESOLVED", "Ce litige a déjà été tranché.");
  }
  const net = orderNet(order);
  const held = (s: string) => order.escrowStatus === "held" || order.escrowStatus === s;
  let buyerPercent = outcome === "refund_buyer" ? 100 : outcome === "release_seller" ? 0 : 50;

  if (outcome === "refund_buyer") {
    if (held("refund_pending")) {
      await refundOrderToBuyer(order, net, "Litige — remboursement acheteur");
    } else {
      order.status = "REFUNDED";
      order.escrowStatus = "refunded";
      order.timeline.push({ status: "REFUNDED", at: new Date(), note: "Litige — acheteur remboursé" });
      await order.save();
    }
  } else if (outcome === "release_seller") {
    if (held("payout_pending")) {
      await payoutOrderToSeller(order, net, "Litige — libération vendeur");
    } else {
      order.status = "FUNDS_RELEASED";
      order.escrowStatus = "released";
      order.timeline.push({ status: "FUNDS_RELEASED", at: new Date(), note: "Litige — vendeur payé" });
      await order.save();
    }
  } else {
    buyerPercent = Math.round(Math.min(100, Math.max(0, Number(opts.buyerPercent ?? 50))));
    const buyerAmt = Math.round((net * buyerPercent) / 100);
    const sellerAmt = net - buyerAmt;
    if (order.escrowStatus === "held") {
      await splitEscrow(order, buyerAmt, sellerAmt);
    } else {
      order.status = "FUNDS_RELEASED";
      order.escrowStatus = "released";
      order.timeline.push({
        status: "FUNDS_RELEASED",
        at: new Date(),
        note: `Litige partagé — ${buyerPercent} % acheteur / ${100 - buyerPercent} % vendeur`,
      });
      await order.save();
    }
  }

  const copy = decisionCopy(outcome, opts.actor, buyerPercent);
  d.status = "resolved";
  d.resolution = outcome;
  d.resolvedBy = opts.actor;
  d.buyerPercent = buyerPercent;
  if (opts.note) d.note = opts.note;
  d.messages.push({
    senderId: opts.actorId,
    senderRole: opts.actor,
    body: opts.note ? `${copy.body}\n${opts.note}` : copy.body,
    fromAdmin: opts.actor === "admin",
    kind: "decision",
    createdAt: new Date(),
  });
  await d.save();

  const data = { disputeId: sid(d._id), orderId: sid(order._id) };
  const buyerId = sid(order.buyerId);
  const sellerId = sid(order.sellerId);
  for (const uid of [buyerId, sellerId]) {
    if (uid !== opts.actorId) await notify(uid, "dispute", copy.title, copy.body, data);
  }
  await notifyAdmins("dispute", copy.title, copy.body, data, opts.actorId);

  return { buyerPercent };
}
