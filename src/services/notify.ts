import { Notification, PushDevice } from "../models/social.js";
import { User } from "../models/user.js";
import { sid } from "../utils/ids.js";
import { courierCoversZone } from "../utils/courier-zones.js";

export const ORDER_STEP_COPY: Record<string, { title: string; body: string }> = {
  ORDERED: { title: "Commande créée", body: "Ta commande a été enregistrée." },
  PAID: { title: "Paiement reçu", body: "Le paiement est bloqué en séquestre." },
  SELLER_NOTIFIED: {
    title: "Nouvelle commande",
    body: "Un acheteur vient de passer commande.",
  },
  PREPARING: {
    title: "Commande en préparation",
    body: "Le vendeur prépare le colis.",
  },
  READY_FOR_PICKUP: {
    title: "Colis prêt",
    body: "Le colis est prêt à être récupéré.",
  },
  COURIER_ASSIGNED: {
    title: "Livreur assigné",
    body: "Un livreur a accepté la mission.",
  },
  COLLECTED: {
    title: "Colis collecté",
    body: "Le livreur a récupéré le colis.",
  },
  IN_TRANSIT: {
    title: "En livraison",
    body: "Le colis est en cours de livraison.",
  },
  DELIVERED: {
    title: "Colis livré",
    body: "Confirme la réception pour libérer le paiement.",
  },
  FUNDS_RELEASED: {
    title: "Fonds libérés",
    body: "Le paiement a été versé au vendeur.",
  },
  DISPUTED: { title: "Litige ouvert", body: "Un litige a été ouvert sur la commande." },
  REFUNDED: { title: "Remboursement", body: "La commande a été remboursée." },
};

export async function notify(
  userId: string,
  type: string,
  title: string,
  body = "",
  data: Record<string, unknown> = {}
) {
  if (!userId) return null;
  return Notification.create({ userId, type, title, body, data });
}

export async function notifyOrderParties(
  order: {
    _id: unknown;
    buyerId: unknown;
    sellerId: unknown;
    courierId?: unknown;
  },
  status: string,
  extraBody?: string
) {
  const copy = ORDER_STEP_COPY[status] || {
    title: "Commande mise à jour",
    body: extraBody || status,
  };
  const payload = { orderId: sid(order._id), status };
  const body = extraBody || copy.body;
  await notify(sid(order.buyerId), "order", copy.title, body, payload);
  await notify(sid(order.sellerId), "order", copy.title, body, payload);
  if (order.courierId) {
    await notify(sid(order.courierId), "order", copy.title, body, payload);
  }
}

export async function notifyCouriersForOrder(order: any) {
  const zoneId = order.pickupZoneId ? String(order.pickupZoneId) : null;
  const couriers = await User.find({
    authAudience: "COURIER",
    banned: { $ne: true },
    "courier.verificationStatus": { $in: ["approved", "pending"] },
  });
  const matched = couriers.filter((c) => courierCoversZone(c.courier, zoneId));
  const title = "Nouvelle mission";
  const body = `Colis à récupérer — ${order.items?.[0]?.title || "commande"}`;
  const ids: unknown[] = [];
  const names: string[] = [];
  for (const c of matched) {
    ids.push(c._id);
    names.push(c.name || "Livreur");
    await notify(sid(c._id), "order", title, body, {
      orderId: sid(order._id),
      status: "READY_FOR_PICKUP",
    });
  }
  return { ids, names };
}

export async function listDeviceTokens(userId: string) {
  return PushDevice.find({ userId }).lean();
}

export async function getSettings() {
  const { PlatformSettings } = await import("../models/catalog.js");
  let settings = await PlatformSettings.findOne({ key: "default" });
  if (!settings) {
    settings = await PlatformSettings.create({ key: "default" });
  }
  return settings;
}
