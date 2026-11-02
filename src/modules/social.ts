import { Router } from "express";
import { z } from "zod";
import { Listing } from "../models/listing.js";
import { Order } from "../models/commerce.js";
import {
  Conversation,
  Favorite,
  Message,
  Notification,
  Offer,
  PushDevice,
} from "../models/social.js";
import { User } from "../models/user.js";
import mongoose from "mongoose";
import {
  COURIER_BUYER_CHAT,
  ensureOrderConversation,
  pairFor,
  pairOfConversation,
  roleInOrder,
  type OrderPair,
  type OrderRole,
} from "../services/courier-announce.js";
import { Report } from "../models/ops.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { notify } from "../services/notify.js";
import { toListing } from "../serializers.js";

export const offersRouter = Router();
offersRouter.use(requireAuth);

offersRouter.get(
  "/mine",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const rows = await Offer.find({ $or: [{ buyerId: uid }, { sellerId: uid }] })
      .sort({ createdAt: -1 })
      .lean();
    res.json(
      rows.map((o) => ({
        id: sid(o._id),
        listingId: sid(o.listingId),
        buyerId: sid(o.buyerId),
        sellerId: sid(o.sellerId),
        amountGnf: o.amountGnf,
        message: o.message,
        status: o.status,
        used: !!o.orderId,
        createdAt: o.createdAt,
      }))
    );
  })
);

offersRouter.get(
  "/listings/:listingId",
  ah(async (req, res) => {
    const rows = await Offer.find({ listingId: req.params.listingId }).lean();
    res.json(
      rows.map((o) => ({
        id: sid(o._id),
        listingId: sid(o.listingId),
        amountGnf: o.amountGnf,
        message: o.message,
        status: o.status,
        createdAt: o.createdAt,
      }))
    );
  })
);

offersRouter.post(
  "/listings/:listingId",
  validate(z.object({ amountGnf: z.number().int().min(1), message: z.string().optional() })),
  ah(async (req, res) => {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) throw notFound();
    if (listing.destination === "ENSEIGNES") {
      throw forbidden("LISTING_NOT_ALLOWED", "Offres interdites sur les enseignes");
    }
    if (!listing.negotiable) {
      throw badRequest("LISTING_NOT_NEGOTIABLE", "Cette annonce n'accepte pas les offres");
    }
    if (req.body.amountGnf >= listing.priceGnf) {
      throw badRequest("OFFER_TOO_HIGH", "L'offre doit être inférieure au prix affiché");
    }
    const offer = await Offer.create({
      listingId: listing._id,
      buyerId: (req as AuthedRequest).userId,
      sellerId: listing.sellerId,
      amountGnf: req.body.amountGnf,
      message: req.body.message || "",
    });
    await notify(sid(listing.sellerId), "offer", "Nouvelle offre", `${req.body.amountGnf} GNF`, {
      offerId: sid(offer._id),
    });
    res.json({ id: sid(offer._id), status: offer.status, amountGnf: offer.amountGnf });
  })
);

offersRouter.patch(
  "/:id/accept",
  ah(async (req, res) => {
    const offer = await Offer.findById(req.params.id);
    if (!offer) throw notFound();
    if (sid(offer.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (offer.status !== "pending") throw badRequest("OFFER_CLOSED", "Cette offre a déjà reçu une réponse.");
    offer.status = "accepted";
    await offer.save();
    await notify(sid(offer.buyerId), "offer", "Offre acceptée", "", { offerId: sid(offer._id) });
    res.json({ id: sid(offer._id), status: offer.status });
  })
);

offersRouter.patch(
  "/:id/refuse",
  ah(async (req, res) => {
    const offer = await Offer.findById(req.params.id);
    if (!offer) throw notFound();
    if (sid(offer.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (offer.status !== "pending") throw badRequest("OFFER_CLOSED", "Cette offre a déjà reçu une réponse.");
    offer.status = "refused";
    await offer.save();
    await notify(sid(offer.buyerId), "offer", "Offre refusée", "", { offerId: sid(offer._id) });
    res.json({ id: sid(offer._id), status: offer.status });
  })
);

const PAIR_LABEL: Record<OrderPair, Record<string, string>> = {
  buyer_seller: { buyer: "Vendeur", seller: "Acheteur" },
  seller_courier: { seller: "Livreur", courier: "Vendeur" },
  buyer_courier: { buyer: "Livreur", courier: "Client" },
};

/** Le livreur et le client ne peuvent échanger qu'une fois le colis collecté. */
function courierBuyerChatBlocked(order: any) {
  return !COURIER_BUYER_CHAT.has(String(order?.status));
}

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get(
  "/",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const rows = await Conversation.find({ participantIds: uid }).sort({ lastMessageAt: -1 }).lean();
    const others = rows.flatMap((c) => c.participantIds.map((p) => sid(p)).filter((id) => id !== uid));
    const orderIds = rows.map((c) => c.orderId).filter(Boolean);
    const [users, orders, unread] = await Promise.all([
      User.find({ _id: { $in: others } }).select("name seller.shopName").lean(),
      Order.find({ _id: { $in: orderIds } }).select("buyerId sellerId courierId status items.title items.imageUrl").lean(),
      Notification.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(uid), read: false, type: "message" } },
        { $group: { _id: "$data.conversationId", n: { $sum: 1 } } },
      ]),
    ]);
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const orderMap = new Map(orders.map((o) => [String(o._id), o]));
    const unreadMap = new Map(unread.map((u) => [String(u._id), u.n as number]));
    res.json(
      rows.map((c) => {
        const otherId = c.participantIds.map((p) => sid(p)).find((id) => id !== uid);
        const other = otherId ? userMap.get(otherId) : null;
        const order = c.orderId ? orderMap.get(String(c.orderId)) : null;
        const pair = c.orderId ? pairOfConversation(c, order as any) : null;
        const myRole = order ? roleInOrder(order as any, uid) : null;
        return {
          id: sid(c._id),
          listingId: c.listingId ? sid(c.listingId) : null,
          orderId: c.orderId ? sid(c.orderId) : null,
          pair,
          myRole,
          peerRoleLabel: pair && myRole ? PAIR_LABEL[pair][myRole] || null : null,
          participantIds: c.participantIds.map((p) => sid(p)),
          lastMessage: c.lastMessage,
          lastMessageAt: c.lastMessageAt,
          unread: unreadMap.get(sid(c._id)) || 0,
          order: order
            ? { title: order.items?.[0]?.title || "Commande", imageUrl: order.items?.[0]?.imageUrl || "", status: order.status }
            : null,
          peer: other ? { id: sid(other._id), name: (other as any).seller?.shopName || other.name } : null,
        };
      })
    );
  })
);

conversationsRouter.post(
  "/",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    let otherId = (req.body.participantIds || []).find((id: string) => id !== uid);
    if (!otherId && req.body.listingId) {
      const listing = await Listing.findById(req.body.listingId);
      if (!listing) throw notFound();
      otherId = sid(listing.sellerId);
    }
    if (req.body.orderId) {
      // Discussion de commande : toujours entre deux rôles précis de CETTE commande.
      const order = await Order.findById(req.body.orderId);
      if (!order) throw notFound();
      const me = roleInOrder(order, uid);
      if (!me) throw forbidden();
      const defaultPeer: Record<OrderRole, OrderRole> = { buyer: "seller", seller: "buyer", courier: "seller" };
      const target = (["buyer", "seller", "courier"].includes(req.body.with) ? req.body.with : defaultPeer[me]) as OrderRole;
      const pair = target === me ? null : pairFor(me, target);
      if (!pair) throw badRequest("NO_PEER", "Destinataire invalide pour cette commande.");
      if (pair !== "buyer_seller" && !order.courierId) {
        throw badRequest("NO_COURIER", "Aucun livreur n'a encore accepté cette course.");
      }
      if (pair === "buyer_courier" && courierBuyerChatBlocked(order)) {
        throw forbidden("CHAT_AFTER_PICKUP", "La discussion avec le livreur s'ouvre une fois le colis récupéré.");
      }
      const conv = await ensureOrderConversation(order, pair);
      if (!conv) throw badRequest("NO_PEER", "Destinataire manquant");
      res.json({ id: sid(conv._id), pair, participantIds: conv.participantIds.map((p) => sid(p)) });
      return;
    }
    if (!otherId) throw badRequest("NO_PEER", "Destinataire manquant");
    let conv = await Conversation.findOne({
      participantIds: { $all: [uid, otherId] },
      listingId: req.body.listingId || null,
      orderId: null,
    });
    if (!conv) {
      conv = await Conversation.create({
        participantIds: [uid, otherId],
        listingId: req.body.listingId || null,
      });
    }
    res.json({ id: sid(conv._id), participantIds: conv.participantIds.map((p) => sid(p)) });
  })
);

async function loadConversationFor(req: AuthedRequest) {
  const conv = await Conversation.findById(req.params.id);
  if (!conv) throw notFound();
  if (!conv.participantIds.map((p) => sid(p)).includes(req.userId!)) throw forbidden();
  return conv;
}

conversationsRouter.get(
  "/:id/messages",
  ah(async (req, res) => {
    const conv = await loadConversationFor(req as AuthedRequest);
    const pair = conv.orderId ? pairOfConversation(conv, (await Order.findById(conv.orderId).lean()) as any) : null;
    const rows = await Message.find({ conversationId: conv._id }).sort({ createdAt: 1 }).lean();
    res.json(
      rows
        // Ancien format : la fiche du livreur était postée chez acheteur ↔ vendeur. Elle n'y a pas sa place.
        .filter((m) => !(pair === "buyer_seller" && m.kind === "courier"))
        .map((m) => ({
          id: sid(m._id),
          senderId: sid(m.senderId),
          body: m.body,
          kind: m.kind || "text",
          meta: m.meta || null,
          createdAt: m.createdAt,
        }))
    );
  })
);

/** Ouvrir une discussion la marque comme lue, ainsi que ses notifications. */
conversationsRouter.post(
  "/:id/read",
  ah(async (req, res) => {
    const conv = await loadConversationFor(req as AuthedRequest);
    const result = await Notification.updateMany(
      { userId: (req as AuthedRequest).userId, read: false, "data.conversationId": sid(conv._id) },
      { $set: { read: true } }
    );
    res.json({ read: result.modifiedCount });
  })
);

conversationsRouter.post(
  "/:id/messages",
  validate(z.object({ body: z.string().min(1).max(4000) })),
  ah(async (req, res) => {
    const conv = await loadConversationFor(req as AuthedRequest);
    const uid = (req as AuthedRequest).userId!;
    const order = conv.orderId ? await Order.findById(conv.orderId).lean() : null;
    const pair = order ? pairOfConversation(conv, order as any) : null;
    if (pair === "buyer_courier" && courierBuyerChatBlocked(order)) {
      throw forbidden("CHAT_AFTER_PICKUP", "La discussion avec le livreur s'ouvre une fois le colis récupéré.");
    }
    const msg = await Message.create({
      conversationId: conv._id,
      senderId: uid,
      body: req.body.body,
    });
    conv.lastMessage = req.body.body;
    conv.lastMessageAt = new Date();
    await conv.save();
    const other = conv.participantIds.map((p) => sid(p)).find((id) => id !== uid);
    if (other) {
      const sender = (req as AuthedRequest).userDoc;
      const senderRole = order ? roleInOrder(order as any, uid) : null;
      const who =
        senderRole === "courier"
          ? `Livreur · ${sender?.name || "Livreur"}`
          : sender?.seller?.shopName || sender?.name || "Nouveau message";
      await notify(other, "message", order ? `${who} · ${order.items?.[0]?.title || "Commande"}` : who, req.body.body, {
        conversationId: sid(conv._id),
        ...(order ? { orderId: sid(order._id), pair } : {}),
      });
    }
    res.json({ id: sid(msg._id), body: msg.body, senderId: uid, createdAt: msg.createdAt });
  })
);

export const favoritesRouter = Router();
favoritesRouter.use(requireAuth);

favoritesRouter.get(
  "/",
  ah(async (req, res) => {
    const rows = await Favorite.find({ userId: (req as AuthedRequest).userId })
      .sort({ createdAt: -1 })
      .populate({ path: "listingId", populate: { path: "sellerId" } })
      .lean();
    res.json(
      rows
        .filter((f: any) => f.listingId && typeof f.listingId === "object")
        .map((f: any) => ({
          id: sid(f._id),
          listingId: sid(f.listingId._id),
          createdAt: f.createdAt,
          listing: toListing(
            { ...f.listingId, sellerId: f.listingId.sellerId?._id ?? f.listingId.sellerId },
            f.listingId.sellerId && typeof f.listingId.sellerId === "object" ? f.listingId.sellerId : undefined
          ),
        }))
    );
  })
);

favoritesRouter.post(
  "/:listingId",
  ah(async (req, res) => {
    const row = await Favorite.findOneAndUpdate(
      { userId: (req as AuthedRequest).userId, listingId: req.params.listingId },
      {},
      { upsert: true, new: true }
    );
    res.json({ id: sid(row._id), listingId: req.params.listingId });
  })
);

favoritesRouter.delete(
  "/:listingId",
  ah(async (req, res) => {
    await Favorite.deleteOne({
      userId: (req as AuthedRequest).userId,
      listingId: req.params.listingId,
    });
    res.json({ status: true });
  })
);

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  "/",
  ah(async (req, res) => {
    const rows = await Notification.find({ userId: (req as AuthedRequest).userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(
      rows.map((n) => ({
        id: sid(n._id),
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        read: n.read,
        createdAt: n.createdAt,
      }))
    );
  })
);

notificationsRouter.patch(
  "/:id/read",
  ah(async (req, res) => {
    const row = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: (req as AuthedRequest).userId },
      { read: true },
      { new: true }
    );
    res.json({ id: sid(row?._id), read: true });
  })
);

/** Ouvrir une commande marque comme lues ses notifications de suivi (pas celles des discussions). */
notificationsRouter.post(
  "/read-order/:orderId",
  ah(async (req, res) => {
    const result = await Notification.updateMany(
      { userId: (req as AuthedRequest).userId, read: false, type: { $ne: "message" }, "data.orderId": String(req.params.orderId) },
      { $set: { read: true } }
    );
    res.json({ read: result.modifiedCount });
  })
);

notificationsRouter.post(
  "/devices",
  validate(
    z.object({
      token: z.string().min(4),
      platform: z.string().optional(),
      audience: z.enum(["CONSUMER", "ADMIN", "COURIER"]).optional(),
    })
  ),
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    await PushDevice.findOneAndUpdate(
      { userId: uid, token: req.body.token },
      {
        userId: uid,
        token: req.body.token,
        platform: req.body.platform || "web",
        audience: req.body.audience || "CONSUMER",
      },
      { upsert: true, new: true }
    );
    res.json({ status: true });
  })
);

notificationsRouter.get(
  "/preferences",
  ah(async (req, res) => {
    res.json((req as AuthedRequest).userDoc?.notifPrefs || []);
  })
);

notificationsRouter.put(
  "/preferences",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const prefs = user.notifPrefs || [];
    const idx = prefs.findIndex((p: any) => p.type === req.body.type);
    if (idx >= 0) Object.assign(prefs[idx], req.body);
    else prefs.push(req.body);
    user.notifPrefs = prefs as any;
    await user.save();
    res.json(user.notifPrefs);
  })
);

export const reportsRouter = Router();
reportsRouter.post(
  "/",
  requireAuth,
  validate(z.object({ reason: z.string().min(3), listingId: z.string().optional(), userId: z.string().optional() })),
  ah(async (req, res) => {
    const row = await Report.create({
      reporterId: (req as AuthedRequest).userId,
      listingId: req.body.listingId || null,
      userId: req.body.userId || null,
      reason: req.body.reason,
    });
    res.json({ id: sid(row._id), status: row.status });
  })
);
