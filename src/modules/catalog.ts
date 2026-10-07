import { Router } from "express";
import { z } from "zod";
import { Category, DeliveryTariff, Zone } from "../models/catalog.js";
import { Listing } from "../models/listing.js";
import { User } from "../models/user.js";
import { optionalAuth, requireAuth, requireAudience } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { notFound } from "../utils/http-error.js";
import { toCategory, toListing, toZone } from "../serializers.js";
import { buildPublicStats } from "../services/stats.js";
import { reviewStatsForSellers, toPublicShop } from "../services/seller-public.js";

export const catalogRouter = Router();

catalogRouter.get(
  "/categories",
  ah(async (_req, res) => {
    const rows = await Category.find().sort({ sortOrder: 1, nameFr: 1 }).lean();
    res.json(rows.map(toCategory));
  })
);

catalogRouter.get(
  "/zones",
  ah(async (_req, res) => {
    const rows = await Zone.find().sort({ code: 1 }).lean();
    res.json(rows.map(toZone));
  })
);

catalogRouter.get(
  "/best-sellers",
  ah(async (_req, res) => {
    const rows = await Listing.find({ status: "ACTIVE" }).sort({ createdAt: -1 }).limit(8).lean();
    res.json(rows.map((r) => toListing(r)));
  })
);

catalogRouter.get(
  "/public-stats",
  ah(async (_req, res) => {
    res.json(await buildPublicStats());
  })
);

catalogRouter.get(
  "/public-settings",
  ah(async (_req, res) => {
    const { getSettings } = await import("../services/notify.js");
    const s = await getSettings();
    res.json({
      platformName: s.platformName || "FripCash",
      contactEmail: s.contactEmail || "",
      contactPhone: s.contactPhone || "",
      maintenanceMode: !!s.maintenanceMode,
    });
  })
);

catalogRouter.get(
  "/tariffs",
  ah(async (_req, res) => {
    const rows = await DeliveryTariff.find().lean();
    res.json(
      rows.map((t) => ({
        id: String(t._id),
        fromZoneId: String(t.fromZoneId),
        toZoneId: String(t.toZoneId),
        amountGnf: t.amountGnf,
      }))
    );
  })
);

catalogRouter.get(
  "/shops",
  ah(async (req, res) => {
    const shopKind = String(req.query.shopKind || "").toLowerCase();
    const q = String(req.query.q || "").trim();
    const createdWithinDays = Number(req.query.createdWithinDays);
    const minRating = Number(req.query.minRating) || 0;
    const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : null;
    const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : null;
    const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 24));
    const filter: Record<string, unknown> = {
      seller: { $ne: null },
    };
    if (shopKind === "particulier") {
      filter["seller.kind"] = "particulier";
    } else if (shopKind === "standard" || shopKind === "proximite" || shopKind === "enseigne") {
      filter["seller.kind"] = "boutique";
      filter["seller.shopKind"] = shopKind;
      if (shopKind === "proximite" || shopKind === "enseigne") {
        filter["seller.verificationStatus"] = "approved";
      }
    } else if (createdWithinDays > 0) {
      filter["seller.kind"] = "boutique";
      filter["seller.verificationStatus"] = "approved";
    } else {
      filter.$or = [
        { "seller.kind": "particulier" },
        {
          "seller.kind": "boutique",
          "seller.shopKind": "standard",
        },
        {
          "seller.kind": "boutique",
          "seller.shopKind": { $in: ["proximite", "enseigne"] },
          "seller.verificationStatus": "approved",
        },
      ];
    }
    if (createdWithinDays > 0 || dateFrom || dateTo) {
      const range: Record<string, Date> = {};
      if (createdWithinDays > 0) {
        range.$gte = new Date(Date.now() - createdWithinDays * 24 * 60 * 60 * 1000);
      }
      if (dateFrom && !Number.isNaN(dateFrom.getTime())) range.$gte = dateFrom;
      if (dateTo && !Number.isNaN(dateTo.getTime())) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
      if (Object.keys(range).length) {
        filter.$and = [
          {
            $or: [
              { "seller.shopCreatedAt": range },
              { "seller.shopCreatedAt": null, createdAt: range },
            ],
          },
        ];
      }
    }
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$and = [
        ...((filter.$and as unknown[]) || []),
        {
          $or: [
            { "seller.shopName": rx },
            { name: rx },
            { "seller.shopDescription": rx },
            { "seller.bio": rx },
          ],
        },
      ];
    }
    const users = await User.find(filter)
      .sort({ "seller.shopCreatedAt": -1, createdAt: -1 })
      .limit(limit)
      .lean();
    const stats = await reviewStatsForSellers(users.map((u) => u._id));
    const shops = users.map((u) => toPublicShop(u, stats.get(String(u._id))));
    res.json(
      minRating > 0 ? shops.filter((s) => (s.rating || 0) >= minRating) : shops
    );
  })
);

const destEnum = z.enum([
  "SECONDE_MAIN",
  "ARTICLES_NEUFS",
  "QUARTIER_BOUTIQUES",
  "ENSEIGNES",
]);

catalogRouter.post(
  "/categories",
  requireAuth,
  requireAudience("ADMIN"),
  validate(
    z.object({
      parentId: z.string().nullable().optional(),
      nameFr: z.string(),
      nameEn: z.string().optional(),
      slug: z.string().optional(),
      destination: destEnum.optional().nullable(),
      sortOrder: z.number().optional(),
      isActive: z.boolean().optional(),
      imageUrl: z.string().nullable().optional(),
      imagePublicId: z.string().nullable().optional(),
    })
  ),
  ah(async (req, res) => {
    const nameFr = String(req.body.nameFr || "").trim();
    const slug =
      req.body.slug ||
      nameFr
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const row = await Category.create({
      ...req.body,
      nameFr,
      nameEn: req.body.nameEn || nameFr,
      slug,
    });
    res.json(toCategory(row));
  })
);

catalogRouter.patch(
  "/categories/:id",
  requireAuth,
  requireAudience("ADMIN"),
  ah(async (req, res) => {
    const row = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!row) throw notFound();
    res.json(toCategory(row));
  })
);

catalogRouter.delete(
  "/categories/:id",
  requireAuth,
  requireAudience("ADMIN"),
  ah(async (req, res) => {
    await Category.findByIdAndDelete(req.params.id);
    res.json({ status: true });
  })
);

catalogRouter.post(
  "/zones",
  requireAuth,
  requireAudience("ADMIN"),
  validate(z.object({ code: z.string(), nameFr: z.string(), nameEn: z.string(), isActive: z.boolean().optional() })),
  ah(async (req, res) => {
    const row = await Zone.create(req.body);
    res.json(toZone(row));
  })
);

catalogRouter.patch(
  "/zones/:id",
  requireAuth,
  requireAudience("ADMIN"),
  ah(async (req, res) => {
    const row = await Zone.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!row) throw notFound();
    res.json(toZone(row));
  })
);

catalogRouter.delete(
  "/zones/:id",
  requireAuth,
  requireAudience("ADMIN"),
  ah(async (req, res) => {
    await Zone.findByIdAndDelete(req.params.id);
    res.json({ status: true });
  })
);

export const unusedOptional = optionalAuth;
