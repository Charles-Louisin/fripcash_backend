/**
 * Messagerie de commande : trois discussions distinctes par commande, chacune entre DEUX parties.
 *   buyer_seller   — acheteur ↔ vendeur
 *   seller_courier — vendeur ↔ livreur (dès l'acceptation de la course)
 *   buyer_courier  — acheteur ↔ livreur (dès la collecte du colis)
 * Ce qui concerne le livreur et le vendeur n'apparaît jamais dans la discussion de l'acheteur, et inversement.
 */
import { Conversation, Message } from "../models/social.js";
import { sid } from "../utils/ids.js";

export type OrderPair = "buyer_seller" | "seller_courier" | "buyer_courier";
export type OrderRole = "buyer" | "seller" | "courier";

/** Statuts à partir desquels le livreur et l'acheteur peuvent échanger (colis collecté). */
export const COURIER_BUYER_CHAT = new Set([
  "COLLECTED",
  "IN_TRANSIT",
  "DELIVERED",
  "FUNDS_RELEASED",
  "FEEDBACK_PENDING",
  "DISPUTED",
]);

type OrderLike = { _id: unknown; buyerId: unknown; sellerId: unknown; courierId?: unknown; status?: string | null };

export function roleInOrder(order: OrderLike, uid: string): OrderRole | null {
  if (sid(order.buyerId) === uid) return "buyer";
  if (sid(order.sellerId) === uid) return "seller";
  if (order.courierId && sid(order.courierId) === uid) return "courier";
  return null;
}

export function pairFor(a: OrderRole, b: OrderRole): OrderPair | null {
  const set = new Set([a, b]);
  if (set.has("buyer") && set.has("seller")) return "buyer_seller";
  if (set.has("seller") && set.has("courier")) return "seller_courier";
  if (set.has("buyer") && set.has("courier")) return "buyer_courier";
  return null;
}

/** Paire d'une conversation de commande (stockée, ou déduite des participants pour l'existant). */
export function pairOfConversation(conv: { pair?: string | null; participantIds: unknown[] }, order: OrderLike | null) {
  if (conv.pair) return conv.pair as OrderPair;
  if (!order) return null;
  const roles = conv.participantIds
    .map((p) => sid(p))
    .map((id) => (id === sid(order.buyerId) ? "buyer" : id === sid(order.sellerId) ? "seller" : "courier")) as OrderRole[];
  return roles.length === 2 ? pairFor(roles[0]!, roles[1]!) : null;
}

export function participantsFor(order: OrderLike, pair: OrderPair, courierId?: unknown) {
  const courier = courierId ?? order.courierId;
  if (pair === "buyer_seller") return [order.buyerId, order.sellerId];
  if (pair === "seller_courier") return [order.sellerId, courier];
  return [order.buyerId, courier];
}

/** Retrouve ou crée LA discussion d'une paire pour une commande. */
export async function ensureOrderConversation(order: OrderLike, pair: OrderPair, courierId?: unknown) {
  const participants = participantsFor(order, pair, courierId).filter(Boolean);
  if (participants.length !== 2) return null;
  let conv = await Conversation.findOne({ orderId: order._id, participantIds: { $all: participants, $size: 2 } });
  if (!conv) {
    conv = await Conversation.create({ participantIds: participants, orderId: order._id, pair });
  } else if (!conv.pair) {
    conv.pair = pair;
    await conv.save();
  }
  return conv;
}

export function courierPublicCard(user: any) {
  const courier = user?.courier || {};
  return {
    kind: "courier" as const,
    name: user?.name || "Livreur",
    phone: user?.phone || "",
    portraitUrl: courier.portraitUrl || user?.avatarUrl || "",
    vehicle: courier.vehicle || "",
    plate: courier.plate || "",
  };
}

async function postCourierCard(conv: any, courierUser: any) {
  const card = courierPublicCard(courierUser);
  const moto = [card.vehicle, card.plate].filter(Boolean).join(" · ");
  const body = [`Livreur : ${card.name}`, moto, card.phone ? `Tél. ${card.phone}` : ""].filter(Boolean).join("\n");
  await Message.create({ conversationId: conv._id, senderId: courierUser._id, body, kind: "courier", meta: card });
  conv.lastMessage = `Livreur : ${card.name}`;
  conv.lastMessageAt = new Date();
  await conv.save();
}

/** Course acceptée : la fiche du livreur arrive dans la discussion vendeur ↔ livreur uniquement. */
export async function announceCourierToSeller(order: OrderLike, courierUser: any) {
  if (!order?.sellerId || !courierUser?._id) return;
  const conv = await ensureOrderConversation(order, "seller_courier", courierUser._id);
  if (conv) await postCourierCard(conv, courierUser);
}

/** Colis collecté : l'acheteur découvre son livreur dans la discussion acheteur ↔ livreur. */
export async function announceCourierToBuyer(order: OrderLike, courierUser: any) {
  if (!order?.buyerId || !courierUser?._id) return;
  const conv = await ensureOrderConversation(order, "buyer_courier", courierUser._id);
  if (conv) await postCourierCard(conv, courierUser);
}
