import { Router } from "express";
import { z } from "zod";
import { Order } from "../models/commerce.js";
import { User } from "../models/user.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { hydrateCourierOrder } from "../services/orders-hydrate.js";
import { payCourierDeliveryFee } from "../services/payments.js";
import { notifyOrderParties } from "../services/notify.js";
import { announceCourierInChat } from "../services/courier-announce.js";
import { courierCoversZone } from "../utils/courier-zones.js";
import mongoose from "mongoose";

export const courierRouter = Router();
courierRouter.use(requireAuth, requireAudience("COURIER"));

const PROGRESS: Record<string, string> = {
  COURIER_ASSIGNED: "COLLECTED",
  COLLECTED: "IN_TRANSIT",
  IN_TRANSIT: "DELIVERED",
};

function kycLocked(user: { courier?: { verificationStatus?: string } | null }) {
  const status = user.courier?.verificationStatus;
  return status === "pending" || status === "approved";
}

function identityDocs(user: any) {
  return (user.kyc?.documents || [])
    .filter((doc: { documentType?: string | null }) => doc.documentType === "identity")
    .map((doc: { url?: string | null; mimeType?: string | null; name?: string | null }) => ({
      url: doc.url || "",
      mimeType: doc.mimeType || "",
      name: doc.name || "",
    }));
}

function courierPayload(user: any, stats: { active: number; delivered: number; availableGnf: number }) {
  const courier = user.courier;
  return {
    id: sid(user._id),
    name: user.name,
    phone: user.phone || "",
    email: user.email || "",
    city: user.city || "",
    bio: user.bio || "",
    avatarUrl: user.avatarUrl || courier?.portraitUrl || "",
    courier: courier
      ? {
          verificationStatus: courier.verificationStatus,
          isAvailable: courier.isAvailable,
          zoneId: courier.zoneId ? sid(courier.zoneId) : null,
          zoneIds: [
            ...new Set(
              [
                ...(courier.zoneIds || []).map((z: unknown) => sid(z)),
                courier.zoneId ? sid(courier.zoneId) : null,
              ].filter(Boolean) as string[]
            ),
          ],
          vehicle: courier.vehicle || "",
          plate: courier.plate || "",
          portraitUrl: courier.portraitUrl || user.avatarUrl || "",
          vehiclePhotoUrl: courier.vehiclePhotoUrl || "",
          rejectionReason: courier.rejectionReason || "",
          kycLocked: kycLocked(user),
          identityDocuments: identityDocs(user),
        }
      : null,
    stats,
  };
}

function requireApproved(user: any) {
  if (user.courier?.verificationStatus !== "approved") {
    throw forbidden("KYC_REQUIRED", "Ton dossier doit être validé avant de prendre une mission.");
  }
}

function applyZones(user: any, zoneIds: string[]) {
  const ids = zoneIds.filter((id) => mongoose.isValidObjectId(id));
  user.courier.zoneIds = ids;
  user.courier.zoneId = ids[0] || null;
}

courierRouter.get(
  "/me",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const uid = (req as AuthedRequest).userId!;
    const mine = await Order.find({ courierId: uid }).lean();
    const active = mine.filter((o) =>
      ["COURIER_ASSIGNED", "COLLECTED", "IN_TRANSIT"].includes(String(o.status))
    ).length;
    const delivered = mine.filter((o) =>
      ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status))
    ).length;
    res.json(
      courierPayload(user, {
        active,
        delivered,
        availableGnf: mine
          .filter((o) => ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status)))
          .reduce((sum, o) => sum + (o.shippingCostGnf || 0), 0),
      })
    );
  })
);

courierRouter.patch(
  "/me/availability",
  validate(z.object({ isAvailable: z.boolean() })),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.courier) throw forbidden();
    if (req.body.isAvailable && user.courier.verificationStatus !== "approved") {
      throw forbidden("KYC_REQUIRED", "Ton dossier doit être validé avant de te rendre disponible.");
    }
    user.courier.isAvailable = req.body.isAvailable;
    await user.save();
    res.json({ isAvailable: user.courier.isAvailable });
  })
);

const profileSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  phone: z.string().min(6).max(24).optional(),
  city: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  vehicle: z.string().max(80).optional(),
  plate: z.string().max(40).optional(),
  portraitUrl: z.string().max(2000).optional(),
  zoneIds: z.array(z.string()).max(12).optional(),
});

courierRouter.patch(
  "/me",
  validate(profileSchema),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.courier) throw forbidden();
    if (req.body.name) user.name = req.body.name.trim();
    if (req.body.city !== undefined) user.city = req.body.city.trim();
    if (req.body.bio !== undefined) user.bio = req.body.bio.trim();
    if (req.body.phone) {
      const phone = String(req.body.phone).replace(/\s/g, "");
      const taken = await User.findOne({ phone, _id: { $ne: user._id } });
      if (taken) throw badRequest("PHONE_TAKEN", "Ce numéro est déjà utilisé.");
      user.phone = phone;
    }
    if (req.body.vehicle !== undefined) user.courier.vehicle = req.body.vehicle.trim();
    if (req.body.plate !== undefined) user.courier.plate = req.body.plate.trim();
    if (req.body.portraitUrl !== undefined) {
      user.courier.portraitUrl = req.body.portraitUrl.trim();
      user.avatarUrl = user.courier.portraitUrl;
    }
    if (Array.isArray(req.body.zoneIds)) applyZones(user, req.body.zoneIds);
    user.markModified("courier");
    await user.save();
    const mine = await Order.find({ courierId: user._id }).lean();
    res.json(
      courierPayload(user, {
        active: mine.filter((o) => ["COURIER_ASSIGNED", "COLLECTED", "IN_TRANSIT"].includes(String(o.status))).length,
        delivered: mine.filter((o) => ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status))).length,
        availableGnf: 0,
      })
    );
  })
);

const kycSchema = z.object({
  portraitUrl: z.string().min(8).max(2000),
  vehiclePhotoUrl: z.string().min(8).max(2000),
  vehicle: z.string().min(1).max(80),
  plate: z.string().min(1).max(40),
  zoneIds: z.array(z.string()).min(1).max(12),
  identityDocuments: z
    .array(
      z.object({
        url: z.string().min(8).max(2000),
        mimeType: z.string().max(120).optional(),
        name: z.string().max(180).optional(),
      })
    )
    .min(1)
    .max(6),
});

courierRouter.post(
  "/kyc",
  validate(kycSchema),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.courier) throw forbidden();
    if (kycLocked(user)) {
      throw forbidden(
        "KYC_LOCKED",
        "La pièce d'identité et la photo du véhicule ne peuvent plus être modifiées."
      );
    }
    user.name = user.name || "Livreur";
    user.courier.vehicle = req.body.vehicle.trim();
    user.courier.plate = req.body.plate.trim();
    user.courier.portraitUrl = req.body.portraitUrl.trim();
    user.courier.vehiclePhotoUrl = req.body.vehiclePhotoUrl.trim();
    user.courier.verificationStatus = "pending";
    user.courier.rejectionReason = "";
    user.courier.isAvailable = false;
    user.avatarUrl = user.courier.portraitUrl;
    applyZones(user, req.body.zoneIds);
    const kept = (user.kyc?.documents || []).filter(
      (doc: { documentType?: string | null }) => !["identity", "vehicle", "portrait"].includes(String(doc.documentType))
    );
    user.kyc = {
      status: "pending",
      note: "",
      documents: [
        ...kept,
        {
          documentType: "portrait",
          url: user.courier.portraitUrl,
          mimeType: "image/jpeg",
          name: "Portrait",
        },
        {
          documentType: "vehicle",
          url: user.courier.vehiclePhotoUrl,
          mimeType: "image/jpeg",
          name: "Véhicule",
        },
        ...req.body.identityDocuments.map((doc: { url: string; mimeType?: string; name?: string }) => ({
          documentType: "identity",
          url: doc.url,
          mimeType: doc.mimeType || "",
          name: doc.name || "Pièce d'identité",
        })),
      ],
    } as any;
    user.markModified("courier");
    user.markModified("kyc");
    await user.save();
    res.json({ verificationStatus: user.courier.verificationStatus });
  })
);

courierRouter.get(
  "/gains",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const deliveredOrders = await Order.find({
      courierId: uid,
      status: { $in: ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"] },
    })
      .sort({ updatedAt: -1 })
      .lean();
    const totalFeesGnf = deliveredOrders.reduce((s, o) => s + (o.shippingCostGnf || 0), 0);
    res.json({
      availableGnf: totalFeesGnf,
      reservedGnf: 0,
      deliveredCount: deliveredOrders.length,
      totalFeesGnf,
      entries: deliveredOrders.map((o) => ({
        id: sid(o._id),
        type: "deliveryFee",
        amountGnf: o.shippingCostGnf || 0,
        isCredit: true,
        label: "Frais de livraison",
        createdAt: o.updatedAt,
      })),
    });
  })
);

courierRouter.get(
  "/missions/open",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (user.courier?.verificationStatus !== "approved") {
      res.json([]);
      return;
    }
    const rows = await Order.find({
      fulfillmentMode: "courier",
      status: { $in: ["PREPARING", "READY_FOR_PICKUP"] },
      courierId: null,
    }).sort({ createdAt: -1 });
    const visible = rows.filter((row) =>
      courierCoversZone(user.courier, row.pickupZoneId ? String(row.pickupZoneId) : null)
    );
    const uid = (req as AuthedRequest).userId!;
    res.json(await Promise.all(visible.map((row) => hydrateCourierOrder(row, uid))));
  })
);

courierRouter.get(
  "/missions",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const rows = await Order.find({ courierId: uid }).sort({
      createdAt: -1,
    });
    res.json(await Promise.all(rows.map((row) => hydrateCourierOrder(row, uid))));
  })
);

courierRouter.post(
  "/missions/:orderId/accept",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    requireApproved(user);
    const row = await Order.findById(req.params.orderId);
    if (!row) throw notFound();
    if (!["PREPARING", "READY_FOR_PICKUP"].includes(String(row.status))) {
      throw badRequest("NOT_OPEN", "Cette mission n'est plus disponible");
    }
    if (!courierCoversZone(user.courier, row.pickupZoneId ? String(row.pickupZoneId) : null)) {
      throw forbidden("ZONE", "Cette mission n'est pas dans tes zones");
    }
    if (row.courierId) throw forbidden("TAKEN", "Mission déjà prise");
    row.courierId = user._id as any;
    row.courierName = user.name;
    row.status = "COURIER_ASSIGNED";
    row.timeline.push({ status: "COURIER_ASSIGNED", at: new Date() });
    await row.save();
    await announceCourierInChat(row, user);
    await notifyOrderParties(row, "COURIER_ASSIGNED", `${user.name} a accepté la course`);
    res.json(await hydrateCourierOrder(row, sid(user._id)));
  })
);

courierRouter.post(
  "/missions/:orderId/progress",
  validate(z.object({ status: z.enum(["COLLECTED", "IN_TRANSIT", "DELIVERED"]) })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.orderId);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (sid(row.courierId) !== uid) throw forbidden();
    const expected = PROGRESS[row.status];
    if (expected !== req.body.status) {
      throw badRequest(
        "ILLEGAL_TRANSITION",
        `Étape suivante attendue : ${expected || "aucune"}`
      );
    }
    if (req.body.status === "DELIVERED" && !row.buyerConfirmedAt) {
      throw badRequest(
        "BUYER_CONFIRMATION_REQUIRED",
        "Le client doit d'abord appuyer sur « Colis reçu » dans son application avant que tu laisses le colis."
      );
    }
    row.status = req.body.status;
    row.timeline.push({ status: req.body.status, at: new Date() });
    if (req.body.status === "DELIVERED") {
      const courier = (req as AuthedRequest).userDoc!;
      await payCourierDeliveryFee(row, courier);
    }
    await row.save();
    await notifyOrderParties(row, req.body.status);
    res.json(await hydrateCourierOrder(row, uid));
  })
);

courierRouter.post(
  "/missions/:orderId/transfer",
  validate(z.object({ toCourierUserId: z.string() })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.orderId);
    if (!row) throw notFound();
    if (sid(row.courierId) !== (req as AuthedRequest).userId) throw forbidden();
    const next = await User.findById(req.body.toCourierUserId);
    if (!next || next.authAudience !== "COURIER") throw notFound();
    row.courierId = next._id as any;
    row.courierName = next.name;
    row.timeline.push({
      status: row.status,
      at: new Date(),
      note: `Transfert vers ${next.name}`,
    });
    await row.save();
    await announceCourierInChat(row, next);
    res.json(await hydrateCourierOrder(row, (req as AuthedRequest).userId!));
  })
);
