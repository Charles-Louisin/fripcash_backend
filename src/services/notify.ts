import { Notification, PushDevice } from "../models/social.js";
import { User } from "../models/user.js";
import { sid } from "../utils/ids.js";
import { courierCoversZone } from "../utils/courier-zones.js";
import { logger } from "../utils/logger.js";
import { sendPush } from "./push.js";

const PREF_OF_TYPE: Record<string, string> = {
  message: "MESSAGE",
  conversation: "MESSAGE",
  order: "ORDER",
  dispute: "ORDER",
  offer: "OFFER",
  promotion: "PROMOTION",
};

async function channelsFor(userId: string, type: string) {
  const prefType = PREF_OF_TYPE[type.toLowerCase()];
  if (!prefType) return { inApp: true, push: true };
  const user = await User.findById(userId).select("notifPrefs").lean();
  const pref = ((user as any)?.notifPrefs || []).find(
    (p: any) => String(p?.type || "").toUpperCase() === prefType
  );
  return { inApp: pref?.inApp !== false, push: pref?.push !== false };
}

export async function notify(
  userId: string,
  type: string,
  title: string,
  body = "",
  data: Record<string, unknown> = {}
) {
  if (!userId) return null;
  const channels = await channelsFor(userId, type);
  const row = channels.inApp ? await Notification.create({ userId, type, title, body, data }) : null;
  if (channels.push) {
    sendPush(userId, title, body, {
      ...data,
      type,
      ...(row ? { notificationId: sid(row._id) } : {}),
    }).catch((err) => logger.warn({ err: String(err) }, "push failed"));
  }
  return row;
}

export async function notifyAdmins(
  type: string,
  title: string,
  body = "",
  data: Record<string, unknown> = {},
  exceptUserId?: string
) {
  const admins = await User.find({
    $or: [{ isAdmin: true }, { authAudience: "ADMIN" }],
    banned: { $ne: true },
  })
    .select("_id")
    .lean();
  for (const admin of admins) {
    const id = sid(admin._id);
    if (id !== exceptUserId) await notify(id, type, title, body, data);
  }
}

export type OrderRole = "buyer" | "seller" | "courier";
type StepCopy = { title: string; body: string } | null;

/**
 * Texte d'une étape de commande pour UN rôle. null = ce rôle n'est pas notifié
 * (il est l'auteur de l'action, ou l'information ne le concerne pas).
 */
export function orderStepCopy(
  status: string,
  role: OrderRole,
  order: { fulfillmentMode?: string | null; courierName?: string | null; courierId?: unknown },
  ctx: { courierName?: string } = {}
): StepCopy {
  const pickup = order.fulfillmentMode === "pickup";
  const byCourier = Boolean(order.courierId || ctx.courierName);
  const courier = ctx.courierName || order.courierName || "Le livreur";
  const carrier = byCourier ? courier : "Le vendeur";
  const copy: Record<string, Partial<Record<OrderRole, StepCopy>>> = {
    SELLER_NOTIFIED: {
      buyer: { title: "Paiement confirmé", body: "Ta commande est payée. Le vendeur va la préparer." },
      seller: { title: "Nouvelle commande", body: "Un client a payé sa commande. Prépare le colis." },
    },
    PREPARING: {
      buyer: { title: "Commande en préparation", body: "Le vendeur prépare ton colis." },
    },
    READY_FOR_PICKUP: {
      buyer: pickup
        ? { title: "Commande prête", body: "Ta commande est prête : présente ton code de retrait au vendeur." }
        : { title: "Colis prêt", body: "Ton colis est prêt, un livreur va venir le récupérer." },
    },
    COURIER_ASSIGNED: {
      seller: { title: "Livreur trouvé", body: `${courier} a accepté la course et vient récupérer le colis.` },
      buyer: { title: "Livreur trouvé", body: "Un livreur va récupérer ton colis chez le vendeur." },
    },
    COLLECTED: {
      buyer: { title: "Colis en route", body: `${courier} a récupéré ton colis et arrive vers toi.` },
      seller: { title: "Colis remis au livreur", body: `${courier} a récupéré le colis.` },
    },
    IN_TRANSIT: {
      buyer: { title: "En livraison", body: `${carrier} est en route avec ton colis.` },
    },
    DELIVERED: {
      buyer: { title: "Colis livré", body: "Vérifie l'article puis appuie sur « Colis reçu »." },
      seller: { title: "Colis livré", body: "Le colis a été remis au client. En attente de sa confirmation." },
    },
    BUYER_CONFIRMED: {
      seller: { title: "Réception confirmée", body: "Le client a confirmé la réception. Ton paiement est en cours." },
    },
    PICKUP_HANDED: {
      buyer: { title: "Retrait validé", body: "Le vendeur a validé ton code. Merci pour ta commande !" },
    },
    FUNDS_RELEASED: {
      seller: { title: "Paiement reçu", body: "Le montant de ta vente a été versé sur ton Mobile Money." },
    },
    REFUNDED: {
      buyer: { title: "Commande remboursée", body: "Ta commande a été annulée et remboursée." },
      seller: { title: "Commande remboursée", body: "La commande a été annulée et remboursée au client." },
    },
  };
  return copy[status]?.[role] ?? null;
}

/** Notifie chaque partie avec SON texte ; l'auteur de l'action peut être exclu. */
export async function notifyOrderParties(
  order: {
    _id: unknown;
    buyerId: unknown;
    sellerId: unknown;
    courierId?: unknown;
    fulfillmentMode?: string | null;
    courierName?: string | null;
  },
  status: string,
  ctx: { courierName?: string; exceptUserId?: string } = {}
) {
  const payload = { orderId: sid(order._id), status };
  const targets: Array<[OrderRole, unknown]> = [
    ["buyer", order.buyerId],
    ["seller", order.sellerId],
    ["courier", order.courierId],
  ];
  for (const [role, userId] of targets) {
    if (!userId || sid(userId) === ctx.exceptUserId) continue;
    const copy = orderStepCopy(status, role, order, ctx);
    if (copy) await notify(sid(userId), "order", copy.title, copy.body, { ...payload, role });
  }
}

/**
 * Notifie les livreurs dont la zone couvre le lieu de collecte. Appelé UNIQUEMENT quand le
 * vendeur appuie sur « Notifier le livreur » (jamais à la mise en préparation).
 */
export async function notifyCouriersForOrder(order: any, options: { excludeIds?: string[] } = {}) {
  const zoneId = order.pickupZoneId ? String(order.pickupZoneId) : null;
  const couriers = await User.find({
    authAudience: "COURIER",
    banned: { $ne: true },
    "courier.verificationStatus": "approved",
  });
  const excluded = new Set(options.excludeIds || []);
  const matched = couriers.filter((c) => courierCoversZone(c.courier, zoneId) && !excluded.has(sid(c._id)));
  const title = "Nouvelle livraison disponible";
  const body = `Colis à récupérer — ${order.items?.[0]?.title || "commande"}`;
  const ids: unknown[] = [];
  const names: string[] = [];
  for (const c of matched) {
    ids.push(c._id);
    names.push(c.name || "Livreur");
    await notify(sid(c._id), "mission", title, body, {
      orderId: sid(order._id),
      status: "READY_FOR_PICKUP",
    });
  }
  return { ids, names };
}

/** La course a été prise : les autres livreurs notifiés sont prévenus (elle disparaît de leur liste). */
export async function notifyCouriersMissionTaken(order: any, acceptedBy: string) {
  for (const id of (order.notifiedCourierIds || []).map((x: unknown) => sid(x))) {
    if (id === acceptedBy) continue;
    await notify(id, "mission", "Livraison acceptée par un autre livreur", `${order.items?.[0]?.title || "Cette commande"} n'est plus disponible.`, {
      orderId: sid(order._id),
      status: "COURIER_ASSIGNED",
    });
  }
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
