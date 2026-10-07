import { Router } from "express";
import { z } from "zod";
import { Listing } from "../models/listing.js";
import {
  Conversation,
  Favorite,
  Message,
  Notification,
  Offer,
  PushDevice,
} from "../models/social.js";
import { User } from "../models/user.js";
import { Report } from "../models/ops.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { notify } from "../services/notify.js";

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
    offer.status = "refused";
    await offer.save();
    await notify(sid(offer.buyerId), "offer", "Offre refusée", "", { offerId: sid(offer._id) });
    res.json({ id: sid(offer._id), status: offer.status });
  })
);

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get(
  "/",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const rows = await Conversation.find({ participantIds: uid }).sort({ lastMessageAt: -1 }).lean();
    const others = rows.flatMap((c) => c.participantIds.map((p) => sid(p)).filter((id) => id !== uid));
    const users = await User.find({ _id: { $in: others } }).lean();
    const map = new Map(users.map((u) => [String(u._id), u]));
    res.json(
      rows.map((c) => {
        const otherId = c.participantIds.map((p) => sid(p)).find((id) => id !== uid);
        const other = otherId ? map.get(otherId) : null;
        return {
          id: sid(c._id),
          listingId: c.listingId ? sid(c.listingId) : null,
          orderId: c.orderId ? sid(c.orderId) : null,
          participantIds: c.participantIds.map((p) => sid(p)),
          lastMessage: c.lastMessage,
          lastMessageAt: c.lastMessageAt,
          peer: other ? { id: sid(other._id), name: other.name } : null,
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
    if (!otherId) throw badRequest("NO_PEER", "Destinataire manquant");
    let conv = req.body.orderId
      ? await Conversation.findOne({
          orderId: req.body.orderId,
          participantIds: { $all: [uid, otherId] },
        })
      : await Conversation.findOne({
          participantIds: { $all: [uid, otherId] },
          listingId: req.body.listingId || null,
        });
    if (!conv) {
      conv = await Conversation.create({
        participantIds: [uid, otherId],
        listingId: req.body.listingId || null,
        orderId: req.body.orderId || null,
      });
    }
    res.json({ id: sid(conv._id), participantIds: conv.participantIds.map((p) => sid(p)) });
  })
);

conversationsRouter.get(
  "/:id/messages",
  ah(async (req, res) => {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (!conv.participantIds.map((p) => sid(p)).includes(uid)) throw forbidden();
    const rows = await Message.find({ conversationId: conv._id }).sort({ createdAt: 1 }).lean();
    res.json(
      rows.map((m) => ({
        id: sid(m._id),
        senderId: sid(m.senderId),
        body: m.body,
        createdAt: m.createdAt,
      }))
    );
  })
);

conversationsRouter.post(
  "/:id/messages",
  validate(z.object({ body: z.string().min(1) })),
  ah(async (req, res) => {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (!conv.participantIds.map((p) => sid(p)).includes(uid)) throw forbidden();
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
      await notify(other, "message", "Nouveau message", req.body.body, {
        conversationId: sid(conv._id),
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
    const rows = await Favorite.find({ userId: (req as AuthedRequest).userId }).populate("listingId");
    res.json(
      rows.map((f) => ({
        id: sid(f._id),
        listingId: sid(f.listingId),
        listing: f.listingId,
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
