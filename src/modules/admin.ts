import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/user.js";
import { Session } from "../models/auth.js";
import { Listing } from "../models/listing.js";
import { Order, Ledger, Wallet } from "../models/commerce.js";
import { Comment, Review } from "../models/social.js";
import { AuditLog, Dispute, OrgKyc, Report } from "../models/ops.js";
import { DeliveryTariff, Partner, Zone } from "../models/catalog.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { ah } from "../utils/async-handler.js";
import { notFound } from "../utils/http-error.js";
import { param, sid } from "../utils/ids.js";
import { toAdminUser, toListing, toMe } from "../serializers.js";
import { getSettings, notify } from "../services/notify.js";
import { hydrateOrder } from "../services/orders-hydrate.js";
import { buildAdminStats } from "../services/stats.js";
import { refundEscrow, releaseEscrow } from "../services/wallet.js";
import {
  buyerDisplayName,
  sellerDisplayName,
  serializeDisputeMessage,
} from "../services/dispute-thread.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAudience("ADMIN"));

function serializeSettings(s: any) {
  return {
    id: "default",
    commissionRateStandard: s.commissionRateStandard,
    commissionRateProximite: s.commissionRateProximite,
    disputeWindowHours: s.disputeWindowHours,
    minWithdrawalGnf: s.minWithdrawalGnf,
    maxListingPhotos: s.maxListingPhotos,
    maintenanceMode: s.maintenanceMode,
    platformName: s.platformName || "FripCash",
    contactEmail: s.contactEmail || "",
    contactPhone: s.contactPhone || "",
    notifyEmail: s.notifyEmail !== false,
    notifySms: s.notifySms !== false,
    notifyDisputes: s.notifyDisputes !== false,
    notifyNewUsers: !!s.notifyNewUsers,
    updatedAt: s.updatedAt,
  };
}

adminRouter.get(
  "/me",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    res.json({
      id: sid(user._id),
      email: user.email,
      name: user.name,
      isAdmin: true,
      permissions: ["*"],
    });
  })
);

adminRouter.get(
  "/stats",
  ah(async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days || 30)));
    res.json(await buildAdminStats(days));
  })
);

adminRouter.get(
  "/platform-settings",
  ah(async (_req, res) => {
    const s = await getSettings();
    res.json(serializeSettings(s));
  })
);

adminRouter.patch(
  "/platform-settings",
  ah(async (req, res) => {
    const s = await getSettings();
    Object.assign(s, req.body);
    await s.save();
    await AuditLog.create({
      actorId: (req as AuthedRequest).userId,
      action: "settings.patch",
      meta: req.body,
    });
    res.json(serializeSettings(s));
  })
);

adminRouter.get(
  "/audit-logs",
  ah(async (_req, res) => {
    const rows = await AuditLog.find().sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows.map((r) => ({ id: sid(r._id), ...r })));
  })
);

adminRouter.post(
  "/users/:userId/provision-audience",
  ah(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { authAudience: req.body.audience, isAdmin: req.body.audience === "ADMIN" },
      { new: true }
    );
    if (!user) throw notFound();
    res.json(toAdminUser(user));
  })
);

adminRouter.get(
  "/listings",
  ah(async (req, res) => {
    const status = String(req.query.status || "ALL");
    const filter = status === "ALL" ? {} : { status };
    const rows = await Listing.find(filter).populate("categoryId").sort({ createdAt: -1 }).lean();
    const sellerIds = [...new Set(rows.map((r) => String(r.sellerId)))];
    const sellers = await User.find({ _id: { $in: sellerIds } }).lean();
    const byId = new Map(sellers.map((s) => [String(s._id), s]));
    res.json(rows.map((r) => toListing(r, byId.get(String(r.sellerId)))));
  })
);

adminRouter.patch(
  "/listings/:id",
  ah(async (req, res) => {
    const row = await Listing.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!row) throw notFound();
    res.json(toListing(row));
  })
);

adminRouter.get(
  "/orders",
  ah(async (_req, res) => {
    const rows = await Order.find().sort({ createdAt: -1 }).limit(300);
    res.json(await Promise.all(rows.map(hydrateOrder)));
  })
);

async function serializeDispute(d: any) {
  const order = d.orderId?.items ? d.orderId : await Order.findById(d.orderId);
  const listingId = order?.items?.[0]?.listingId;
  const listing = listingId ? await Listing.findById(listingId).lean() : null;
  const thumb = listing?.media?.[0]?.url || listing?.media?.[0]?.storageKey || "";
  const [buyer, seller, opener] = await Promise.all([
    order ? User.findById(order.buyerId).lean() : null,
    order ? User.findById(order.sellerId).lean() : null,
    d.openedBy ? User.findById(d.openedBy).lean() : null,
  ]);
  const resolution = String(d.resolution || "");
  let outcome: string | undefined;
  if (resolution === "resolved_buyer" || resolution === "refund_buyer") outcome = "refund_buyer";
  else if (resolution === "partial_refund") outcome = "partial_refund";
  else if (resolution === "resolved_seller" || resolution === "release_seller") outcome = "release_seller";
  return {
    id: sid(d._id),
    orderId: sid(order?._id || d.orderId),
    productTitle: order?.items?.[0]?.title || "Article",
    productImage: thumb,
    listingImageUrl: thumb,
    buyerId: order ? sid(order.buyerId) : null,
    sellerId: order ? sid(order.sellerId) : null,
    buyerName: buyerDisplayName(buyer),
    sellerName: sellerDisplayName(seller),
    amount: order?.amountGnf || 0,
    reason: d.reason,
    initiatedBy: d.openerRole || "buyer",
    initiatorName:
      d.openerRole === "seller"
        ? sellerDisplayName(seller)
        : buyerDisplayName(opener || buyer),
    openedVia: "order_page",
    status: d.status,
    outcome,
    openedAt: d.createdAt,
    resolvedAt: d.status === "resolved" ? d.updatedAt : undefined,
    notes: d.note || "",
    evidence: (d.evidence || []).map((e: any) => ({
      url: e.url,
      storageKey: e.storageKey,
      mimeType: e.mimeType,
      name: e.name,
    })),
    messages: (d.messages || []).map((m: any) =>
      serializeDisputeMessage(m, { order, buyer, seller })
    ),
    escrowStatus: order?.escrowStatus,
  };
}

adminRouter.get(
  "/disputes",
  ah(async (_req, res) => {
    const rows = await Dispute.find().sort({ createdAt: -1 }).lean();
    res.json(await Promise.all(rows.map(serializeDispute)));
  })
);

adminRouter.post(
  "/disputes/:id/resolve",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    const order = await Order.findById(d.orderId);
    if (!order) throw notFound();
    const resolution = req.body.resolution || req.body.outcome;
    const net = order.items.reduce((s: number, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1), 0);
    if (resolution === "resolved_buyer" || resolution === "refund_buyer") {
      if (order.escrowStatus === "held") {
        await refundEscrow(sid(order.sellerId), sid(order.buyerId), net, sid(order._id));
      }
      order.status = "REFUNDED";
      order.escrowStatus = "refunded";
    } else if (resolution === "partial_refund") {
      const buyerPct = Math.min(100, Math.max(0, Number(req.body.buyerPercent ?? 50)));
      const sellerPct = Math.min(100, Math.max(0, Number(req.body.sellerPercent ?? 100 - buyerPct)));
      const buyerAmt = Math.round((net * buyerPct) / 100);
      const sellerAmt = Math.round((net * sellerPct) / 100);
      if (order.escrowStatus === "held") {
        if (buyerAmt > 0) await refundEscrow(sid(order.sellerId), sid(order.buyerId), buyerAmt, sid(order._id));
        if (sellerAmt > 0) await releaseEscrow(sid(order.sellerId), sellerAmt, sid(order._id));
      }
      order.status = "FUNDS_RELEASED";
      order.escrowStatus = "released";
    } else {
      if (order.escrowStatus === "held") {
        await releaseEscrow(sid(order.sellerId), net, sid(order._id));
      }
      order.status = "FUNDS_RELEASED";
      order.escrowStatus = "released";
    }
    d.status = "resolved";
    d.resolution = resolution;
    d.note = req.body.note || "";
    await d.save();
    await order.save();
    await notify(sid(order.buyerId), "dispute", "Litige résolu", resolution);
    await notify(sid(order.sellerId), "dispute", "Litige résolu", resolution);
    res.json({ id: sid(d._id), status: d.status, resolution });
  })
);

adminRouter.post(
  "/disputes/:id/review",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    d.status = "under_review";
    if (req.body.note) d.note = req.body.note;
    await d.save();
    res.json(await serializeDispute(d.toObject()));
  })
);

adminRouter.post(
  "/disputes/:id/ask-party",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    d.messages.push({
      senderId: (req as AuthedRequest).userId as any,
      senderRole: "admin",
      body: req.body.message || "Merci de répondre au litige et d'ajouter des preuves.",
      fromAdmin: true,
      kind: req.body.kind || "info_request",
      requestedKinds: req.body.requestedKinds || ["text", "image", "document"],
      attachments: req.body.attachments || [],
      createdAt: new Date(),
    } as any);
    await d.save();
    res.json(await serializeDispute(d.toObject()));
  })
);

adminRouter.get(
  "/seller-verifications",
  ah(async (_req, res) => {
    const users = await User.find({
      "seller.kind": "boutique",
      "seller.verificationStatus": { $in: ["pending", "rejected"] },
    });
    res.json(
      users.map((u) => ({
        id: sid(u._id),
        userId: sid(u._id),
        shopName: u.seller?.shopName,
        shopKind: u.seller?.shopKind,
        verificationStatus: u.seller?.verificationStatus,
        rejectionReason: u.seller?.rejectionReason || "",
        displayName: u.name,
        phone: u.phone,
        avatarUrl: (u as any).avatarUrl || "",
        coverUrl: u.seller?.coverUrl || "",
        shopDescription: u.seller?.shopDescription || "",
        createdAt: u.seller?.shopCreatedAt || u.createdAt,
        documents: u.seller?.kycDocuments || [],
        messages: (u.seller?.verificationMessages || []).map((m: any) => ({
          senderId: m.senderId ? sid(m.senderId) : null,
          fromAdmin: !!m.fromAdmin,
          body: m.body,
          attachments: m.attachments || [],
          createdAt: m.createdAt,
        })),
      }))
    );
  })
);

adminRouter.post(
  "/seller-verifications/:id/messages",
  ah(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user?.seller) throw notFound();
    user.seller.verificationMessages = user.seller.verificationMessages || [];
    user.seller.verificationMessages.push({
      senderId: (req as AuthedRequest).userId as any,
      fromAdmin: true,
      body: req.body.body || req.body.message || "",
      attachments: req.body.attachments || [],
      createdAt: new Date(),
    } as any);
    await user.save();
    res.json({ id: sid(user._id), messages: user.seller.verificationMessages });
  })
);

adminRouter.post(
  "/seller-verifications/:id/approve",
  ah(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user?.seller) throw notFound();
    user.seller.verificationStatus = "approved";
    await user.save();
    await notify(sid(user._id), "shop", "Boutique validée", "Vous pouvez publier");
    res.json(toMe(user));
  })
);

adminRouter.post(
  "/seller-verifications/:id/reject",
  ah(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user?.seller) throw notFound();
    user.seller.verificationStatus = "rejected";
    user.seller.rejectionReason = req.body.reviewerNote || "";
    await user.save();
    await notify(sid(user._id), "shop", "Boutique refusée", req.body.reviewerNote || "");
    res.json(toMe(user));
  })
);

adminRouter.get(
  "/kyc/organizations",
  ah(async (_req, res) => {
    const rows = await OrgKyc.find().lean();
    res.json(rows.map((r) => ({ id: sid(r._id), ...r })));
  })
);

adminRouter.get(
  "/kyc/individuals",
  ah(async (_req, res) => {
    const users = await User.find({ "kyc.status": { $in: ["pending", "rejected"] } });
    res.json(users.map((u) => ({ id: sid(u._id), name: u.name, kyc: u.kyc })));
  })
);

async function setOrgKyc(id: string, status: string, note?: string) {
  const row = await OrgKyc.findByIdAndUpdate(id, { status, note: note || "" }, { new: true });
  if (!row) throw notFound();
  return row;
}

adminRouter.post("/kyc/organizations/:id/approve", ah(async (req, res) => {
  res.json(await setOrgKyc(param(req.params.id), "approved", req.body.reviewerNote));
}));
adminRouter.post("/kyc/organizations/:id/reject", ah(async (req, res) => {
  res.json(await setOrgKyc(param(req.params.id), "rejected", req.body.reviewerNote));
}));
adminRouter.post("/kyc/organizations/:id/request-resubmission", ah(async (req, res) => {
  res.json(await setOrgKyc(param(req.params.id), "resubmit", req.body.reviewerNote));
}));

adminRouter.post(
  "/kyc/individuals/:id/approve",
  ah(async (req, res) => {
    const user = await User.findByIdAndUpdate(req.params.id, { "kyc.status": "approved" }, { new: true });
    if (!user) throw notFound();
    res.json({ id: sid(user._id), kyc: user.kyc });
  })
);
adminRouter.post(
  "/kyc/individuals/:id/reject",
  ah(async (req, res) => {
    const user = await User.findByIdAndUpdate(req.params.id, { "kyc.status": "rejected" }, { new: true });
    if (!user) throw notFound();
    res.json({ id: sid(user._id), kyc: user.kyc });
  })
);

adminRouter.post("/reviews/:id/hide", ah(async (req, res) => {
  await Review.findByIdAndUpdate(req.params.id, { hidden: true });
  res.json({ status: true });
}));
adminRouter.post("/comments/:id/hide", ah(async (req, res) => {
  await Comment.findByIdAndUpdate(req.params.id, { hidden: true });
  res.json({ status: true });
}));

adminRouter.get(
  "/wallets",
  ah(async (_req, res) => {
    const rows = await Wallet.find().populate("userId", "name email phone seller").lean();
    res.json(
      rows.map((w) => {
        const u: any = w.userId;
        const userDoc = u && typeof u === "object" && u.name !== undefined ? u : null;
        return {
          id: sid(w._id),
          userId: sid(userDoc?._id || w.userId),
          user: userDoc
            ? {
                id: sid(userDoc._id),
                name: userDoc.name || userDoc.seller?.shopName || "Utilisateur",
                email: userDoc.email || "",
                phone: userDoc.phone || "",
              }
            : null,
          availableGnf: w.availableGnf,
          reservedGnf: w.reservedGnf,
        };
      })
    );
  })
);

adminRouter.get(
  "/sessions",
  ah(async (_req, res) => {
    const rows = await Session.find().sort({ createdAt: -1 }).limit(200).lean();
    const userIds = [...new Set(rows.map((s) => String(s.userId)))];
    const users = await User.find({ _id: { $in: userIds } }).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const now = Date.now();
    res.json(
      rows.map((s) => {
        const u = byId.get(String(s.userId));
        const expired = s.expiresAt ? new Date(s.expiresAt).getTime() < now : false;
        return {
          id: sid(s._id),
          userId: sid(s.userId),
          audience: s.audience,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          displayName: u?.name || u?.email || sid(s.userId),
          email: u?.email || "",
          status: expired ? "ended" : "active",
        };
      })
    );
  })
);

adminRouter.get(
  "/signalements",
  ah(async (_req, res) => {
    const rows = await Report.find().sort({ createdAt: -1 }).lean();
    const listingIds = rows.map((r) => r.listingId).filter(Boolean);
    const listings = listingIds.length
      ? await Listing.find({ _id: { $in: listingIds } }).lean()
      : [];
    const listingById = new Map(listings.map((l) => [String(l._id), l]));
    const reporters = await User.find({
      _id: { $in: rows.map((r) => r.reporterId) },
    }).lean();
    const reporterById = new Map(reporters.map((u) => [String(u._id), u]));
    res.json(
      rows.map((r) => ({
        id: sid(r._id),
        reporterId: sid(r.reporterId),
        reporterName: reporterById.get(String(r.reporterId))?.name || "Utilisateur",
        listingId: r.listingId ? sid(r.listingId) : null,
        userId: r.userId ? sid(r.userId) : null,
        target: r.listingId
          ? listingById.get(String(r.listingId))?.title || sid(r.listingId)
          : r.userId
            ? sid(r.userId)
            : "—",
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      }))
    );
  })
);

adminRouter.post(
  "/signalements/:id/resolve",
  ah(async (req, res) => {
    const row = await Report.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status || "resolved" },
      { new: true }
    );
    if (!row) throw notFound();
    res.json({ id: sid(row._id), status: row.status });
  })
);

adminRouter.get(
  "/partenaires",
  ah(async (_req, res) => {
    const [partners, enseignes] = await Promise.all([
      Partner.find().lean(),
      User.find({ "seller.shopKind": "enseigne" }).lean(),
    ]);
    const fromUsers = enseignes.map((u) => ({
      id: sid(u._id),
      name: u.seller?.shopName || u.name,
      contactEmail: u.email,
      kind: "enseigne",
      status: u.seller?.verificationStatus === "approved" ? "active" : "pending",
      note: u.seller?.verificationStatus || "",
      userId: sid(u._id),
      source: "user",
    }));
    const fromDocs = partners.map((p) => ({
      id: sid(p._id),
      name: p.name,
      kind: p.kind,
      status: p.status,
      note: p.note,
      userId: p.userId ? sid(p.userId) : null,
      source: "partner",
    }));
    res.json([...fromUsers, ...fromDocs]);
  })
);

adminRouter.post(
  "/partenaires",
  ah(async (req, res) => {
    const row = await Partner.create(req.body);
    res.json({ id: sid(row._id), ...row.toObject() });
  })
);

adminRouter.get(
  "/livreurs",
  ah(async (_req, res) => {
    const rows = await User.find({ authAudience: "COURIER" });
    const ids = rows.map((u) => u._id);
    const orders = await Order.find({ courierId: { $in: ids } }).lean();
    const byCourier = new Map<string, { active: number; delivered: number; blocked: number }>();
    for (const o of orders) {
      const id = String(o.courierId);
      const prev = byCourier.get(id) || { active: 0, delivered: 0, blocked: 0 };
      if (["COURIER_ASSIGNED", "COLLECTED", "IN_TRANSIT"].includes(String(o.status))) prev.active += 1;
      if (["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status))) prev.delivered += 1;
      if (o.status === "DISPUTED") prev.blocked += 1;
      byCourier.set(id, prev);
    }
    const zones = await Zone.find().lean();
    const zoneById = new Map(zones.map((z) => [String(z._id), z.nameFr]));
    res.json(
      rows.map((u) => {
        const stats = byCourier.get(String(u._id)) || { active: 0, delivered: 0, blocked: 0 };
        return {
          ...toAdminUser(u),
          phone: u.phone,
          isAvailable: !!u.courier?.isAvailable,
          vehicleType: u.courier?.vehicle || "",
          zoneId: u.courier?.zoneId ? sid(u.courier.zoneId) : null,
          zoneIds: [
            ...new Set(
              [
                ...(u.courier?.zoneIds || []).map((z: unknown) => sid(z)),
                u.courier?.zoneId ? sid(u.courier.zoneId) : null,
              ].filter(Boolean) as string[]
            ),
          ],
          zoneName: u.courier?.zoneId ? zoneById.get(String(u.courier.zoneId)) : null,
          zoneNames: [
            ...new Set(
              [
                ...(u.courier?.zoneIds || []).map((z: unknown) => zoneById.get(String(z))),
                u.courier?.zoneId ? zoneById.get(String(u.courier.zoneId)) : null,
              ].filter(Boolean) as string[]
            ),
          ],
          activeMissions: stats.active,
          deliveredCount: stats.delivered,
          blockedMissions: stats.blocked,
        };
      })
    );
  })
);

adminRouter.patch(
  "/livreurs/:id",
  ah(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user || user.authAudience !== "COURIER") throw notFound();
    if (!user.courier) {
      user.set("courier", {
        verificationStatus: "approved",
        isAvailable: false,
        zoneId: null,
        zoneIds: [],
        vehicle: "",
        plate: "",
      });
    }
    const courier = user.courier!;
    if (Array.isArray(req.body.zoneIds)) {
      const ids = req.body.zoneIds.filter(Boolean);
      courier.zoneIds = ids as any;
      courier.zoneId = ids[0] || null;
    } else if (req.body.zoneId !== undefined) {
      courier.zoneId = req.body.zoneId || null;
      const current = new Set(
        (courier.zoneIds || []).map((z: unknown) => String(z)).filter(Boolean)
      );
      if (req.body.zoneId) current.add(String(req.body.zoneId));
      else current.clear();
      courier.zoneIds = [...current] as any;
    }
    if (typeof req.body.isAvailable === "boolean") {
      courier.isAvailable = req.body.isAvailable;
    }
    if (req.body.status === "available") courier.isAvailable = true;
    if (req.body.status === "unavailable") courier.isAvailable = false;
    user.markModified("courier");
    await user.save();
    const zoneIds = [
      ...new Set(
        [
          ...(courier.zoneIds || []).map((z: unknown) => sid(z)),
          courier.zoneId ? sid(courier.zoneId) : null,
        ].filter(Boolean) as string[]
      ),
    ];
    const zones = zoneIds.length
      ? await Zone.find({ _id: { $in: zoneIds } }).lean()
      : [];
    res.json({
      ...toAdminUser(user),
      isAvailable: !!courier.isAvailable,
      zoneId: courier.zoneId ? sid(courier.zoneId) : null,
      zoneIds,
      zoneName: zones[0]?.nameFr || null,
      zoneNames: zones.map((z) => z.nameFr),
    });
  })
);

adminRouter.get(
  "/tarifs",
  ah(async (_req, res) => {
    const rows = await DeliveryTariff.find().lean();
    res.json(
      rows.map((t) => ({
        id: sid(t._id),
        fromZoneId: sid(t.fromZoneId),
        toZoneId: sid(t.toZoneId),
        amountGnf: t.amountGnf,
      }))
    );
  })
);

adminRouter.put(
  "/tarifs",
  ah(async (req, res) => {
    const items = z
      .array(
        z.object({
          fromZoneId: z.string(),
          toZoneId: z.string(),
          amountGnf: z.number(),
        })
      )
      .parse(req.body.items || req.body);
    await DeliveryTariff.deleteMany({});
    if (items.length) await DeliveryTariff.insertMany(items);
    const rows = await DeliveryTariff.find().lean();
    res.json(rows.map((t) => ({ id: sid(t._id), ...t })));
  })
);

adminRouter.get(
  "/rapports",
  ah(async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days || 30)));
    res.json(await buildAdminStats(days));
  })
);

export const authAdminRouter = Router();

authAdminRouter.post(
  "/login",
  ah(async (req, res) => {
    const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    req.body = parsed;
    const { handleAdminLogin } = await import("./auth.js");
    await handleAdminLogin(req as AuthedRequest, res);
  })
);

authAdminRouter.use(requireAuth, requireAudience("ADMIN"));

authAdminRouter.get(
  "/list-users",
  ah(async (req, res) => {
    const limit = Number(req.query.limit || 100);
    const offset = Number(req.query.offset || 0);
    const q: Record<string, unknown> = {};
    if (req.query.searchValue) {
      const v = { $regex: String(req.query.searchValue), $options: "i" };
      q.$or = [{ name: v }, { email: v }, { phone: v }];
    }
    const [users, total] = await Promise.all([
      User.find(q).skip(offset).limit(limit).sort({ createdAt: -1 }),
      User.countDocuments(q),
    ]);
    res.json({ users: users.map(toAdminUser), total, limit, offset });
  })
);

authAdminRouter.get(
  "/get-user",
  ah(async (req, res) => {
    const user = await User.findById(req.query.id);
    if (!user) throw notFound();
    res.json(toAdminUser(user));
  })
);

authAdminRouter.post(
  "/create-user",
  ah(async (req, res) => {
    const role = Array.isArray(req.body.role) ? req.body.role[0] : req.body.role;
    const audience =
      role === "admin" ? "ADMIN" : role === "courier" || role === "livreur" ? "COURIER" : "CONSUMER";
    const user = await User.create({
      email: req.body.email,
      name: req.body.name,
      passwordHash: await bcrypt.hash(req.body.password, 10),
      authAudience: audience,
      isAdmin: role === "admin",
      courier:
        audience === "COURIER"
          ? { verificationStatus: "approved", isAvailable: false }
          : undefined,
    });
    res.json({ user: toAdminUser(user) });
  })
);

authAdminRouter.post(
  "/update-user",
  ah(async (req, res) => {
    const user = await User.findByIdAndUpdate(req.body.userId, req.body.data || {}, { new: true });
    if (!user) throw notFound();
    res.json({ user: toAdminUser(user) });
  })
);

authAdminRouter.post(
  "/set-role",
  ah(async (req, res) => {
    const role = Array.isArray(req.body.role) ? req.body.role[0] : req.body.role;
    const user = await User.findById(req.body.userId);
    if (!user) throw notFound();
    user.isAdmin = role === "admin";
    if (role === "admin") user.authAudience = "ADMIN";
    if (role === "courier") user.authAudience = "COURIER";
    await user.save();
    res.json({ user: toAdminUser(user) });
  })
);

authAdminRouter.post(
  "/set-user-password",
  ah(async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user) throw notFound();
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
    await user.save();
    res.json({ status: true });
  })
);

authAdminRouter.post(
  "/remove-user",
  ah(async (req, res) => {
    await User.findByIdAndDelete(req.body.userId);
    res.json({ status: true });
  })
);

authAdminRouter.post(
  "/ban-user",
  ah(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.body.userId,
      { banned: true, banReason: req.body.banReason || "Banned by admin" },
      { new: true }
    );
    res.json({ user: user ? toAdminUser(user) : null });
  })
);

authAdminRouter.post(
  "/unban-user",
  ah(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.body.userId,
      { banned: false, banReason: null },
      { new: true }
    );
    res.json({ user: user ? toAdminUser(user) : null });
  })
);

authAdminRouter.post(
  "/list-user-sessions",
  ah(async (req, res) => {
    const rows = await Session.find({ userId: req.body.userId }).lean();
    res.json({
      sessions: rows.map((s) => ({
        id: sid(s._id),
        token: s.token,
        userId: sid(s.userId),
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
      })),
    });
  })
);

authAdminRouter.post(
  "/revoke-user-session",
  ah(async (req, res) => {
    await Session.deleteOne({ token: req.body.sessionToken });
    res.json({ status: true });
  })
);

authAdminRouter.post(
  "/revoke-user-sessions",
  ah(async (req, res) => {
    await Session.deleteMany({ userId: req.body.userId });
    res.json({ status: true });
  })
);

authAdminRouter.post("/impersonate-user", ah(async (_req, res) => res.json({ error: "disabled" })));
authAdminRouter.post("/stop-impersonating", ah(async (_req, res) => res.json({ status: true })));
authAdminRouter.post("/has-permission", ah(async (_req, res) => res.json({ success: true })));

export const unusedLedger = Ledger;
