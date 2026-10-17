import { Router } from "express";
import { z } from "zod";
import { User } from "../models/user.js";
import { OrgKyc } from "../models/ops.js";
import { LibraryItem } from "../models/listing.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden } from "../utils/http-error.js";
import { destinationForSeller } from "../utils/pricing.js";
import { computeCapabilities } from "../utils/capabilities.js";
import { toMe } from "../serializers.js";
import { AuditLog } from "../models/ops.js";
import { parseGnMobile } from "../services/gn-phone.js";
import {
  setUserShippingZone,
  syncSellerListingZones,
} from "../utils/shipping-zone.js";

export const meRouter = Router();

meRouter.use(requireAuth, requireAudience("CONSUMER", "ADMIN"));

meRouter.get(
  "/",
  ah(async (req, res) => {
    res.json(toMe((req as AuthedRequest).userDoc!));
  })
);

meRouter.patch(
  "/",
  validate(
    z.object({
      name: z.string().min(1).optional(),
      preferredLocale: z.enum(["FR", "EN"]).optional(),
      city: z.string().max(120).optional(),
      bio: z.string().max(200).optional(),
      avatarUrl: z.string().max(2000).optional(),
      coverUrl: z.string().max(2000).optional(),
      phone: z.string().max(32).optional(),
      shippingZoneId: z.string().min(1).optional(),
    })
  ),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (req.body.name) user.name = req.body.name;
    if (req.body.preferredLocale) user.preferredLocale = req.body.preferredLocale;
    if (req.body.city !== undefined) (user as any).city = req.body.city;
    if (req.body.bio !== undefined) {
      (user as any).bio = req.body.bio;
      if (user.seller) user.seller.bio = req.body.bio;
    }
    if (req.body.avatarUrl !== undefined) (user as any).avatarUrl = req.body.avatarUrl;
    if (req.body.coverUrl !== undefined && user.seller) {
      user.seller.coverUrl = req.body.coverUrl;
    }
    if (req.body.phone !== undefined && req.body.phone) user.phone = req.body.phone;
    if (req.body.shippingZoneId) {
      await setUserShippingZone(user, req.body.shippingZoneId);
    }
    await user.save();
    if (req.body.shippingZoneId) {
      await syncSellerListingZones(user._id, user.shippingZoneId);
    }
    res.json(toMe(user));
  })
);

meRouter.post(
  "/seller/particulier",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (user.authAudience !== "CONSUMER") throw forbidden();
    if (user.seller?.kind === "boutique") {
      throw badRequest(
        "ALREADY_SHOP",
        "Boutique, commerce ou enseigne : tu es déjà vendeur. Pas besoin d’activer un profil particulier."
      );
    }
    const zoneId = req.body?.shippingZoneId || user.shippingZoneId;
    if (!zoneId) {
      throw badRequest(
        "MISSING_SHIPPING_ZONE",
        "Choisis ta zone d’expédition pour vendre."
      );
    }
    await setUserShippingZone(user, String(zoneId));
    user.seller = {
      kind: "particulier",
      shopKind: null,
      shopName: req.body?.displayName || user.name,
      shopDescription: req.body?.bio || "",
      bio: req.body?.bio || "",
      verificationStatus: "approved",
      listingDestination: "SECONDE_MAIN",
    } as any;
    await user.save();
    res.json(toMe(user));
  })
);

meRouter.post(
  "/seller/shop",
  validate(
    z.object({
      shopKind: z.enum(["STANDARD", "PROXIMITE", "ENSEIGNE"]),
      name: z.string().min(1),
      description: z.string().min(1, "Ajoute une description."),
      coverUrl: z.string().max(2000).optional(),
      storeAddress: z.string().max(300).optional(),
      soldCategories: z.array(z.string().min(1).max(80)).max(30).optional(),
      deliveredCommunes: z.array(z.string().min(1).max(80)).max(30).optional(),
      deliveryDelay: z.string().max(80).optional(),
      neighborhood: z.string().max(120).optional(),
      landmark: z.string().max(300).optional(),
      orangeMoneyPhone: z.string().max(32).optional(), // validated below as GN MM
      openingTime: z.string().max(20).optional(),
      closingTime: z.string().max(20).optional(),
      shippingZoneId: z.string().min(1).optional(),
      documents: z
        .array(
          z.object({
            url: z.string(),
            storageKey: z.string().optional(),
            mimeType: z.string().optional(),
            name: z.string().optional(),
            documentType: z.string().optional(),
          })
        )
        .min(1, "Ajoute au moins une pièce KYC."),
    })
  ),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const shopKind = req.body.shopKind.toLowerCase() as "standard" | "proximite" | "enseigne";
    const needsReview = shopKind === "proximite" || shopKind === "enseigne";
    const sameKind = user.seller?.kind === "boutique" && user.seller.shopKind === shopKind;
    const emptyShop = !(user.seller?.kycDocuments?.length);
    if (
      user.seller?.kind === "boutique" &&
      user.seller.verificationStatus !== "rejected" &&
      !sameKind &&
      !emptyShop
    ) {
      throw badRequest(
        "ALREADY_SHOP",
        "Tu as déjà une boutique ou une enseigne sur ce compte."
      );
    }
    if (req.body.orangeMoneyPhone) {
      const parsed = parseGnMobile(req.body.orangeMoneyPhone);
      if (!parsed) {
        throw badRequest(
          "PHONE",
          "Le numéro Mobile Money doit être un mobile guinéen Orange (62) ou MTN (65)."
        );
      }
      req.body.orangeMoneyPhone = parsed.e164;
    }
    const zoneId = req.body.shippingZoneId || user.shippingZoneId;
    if (!zoneId) {
      throw badRequest(
        "MISSING_SHIPPING_ZONE",
        "Choisis ta zone d’expédition pour vendre."
      );
    }
    await setUserShippingZone(user, String(zoneId));
    user.seller = {
      kind: "boutique",
      shopKind,
      shopName: req.body.name,
      shopDescription: req.body.description || "",
      bio: req.body.description || "",
      coverUrl: req.body.coverUrl || user.seller?.coverUrl || "",
      likesCount: user.seller?.likesCount || 0,
      shopCreatedAt: user.seller?.shopCreatedAt || new Date(),
      kycDocuments: (req.body.documents || user.seller?.kycDocuments || []).map((d: any) => ({
        ...d,
        createdAt: d.createdAt || new Date(),
      })),
      verificationMessages: user.seller?.verificationMessages || [],
      verificationStatus: needsReview ? "pending" : "approved",
      listingDestination: destinationForSeller("boutique", shopKind),
      storeAddress: req.body.storeAddress || "",
      soldCategories: req.body.soldCategories || [],
      deliveredCommunes: req.body.deliveredCommunes || [],
      deliveryDelay: req.body.deliveryDelay || "",
      neighborhood: req.body.neighborhood || "",
      landmark: req.body.landmark || "",
      orangeMoneyPhone: req.body.orangeMoneyPhone || "",
      openingTime: req.body.openingTime || "",
      closingTime: req.body.closingTime || "",
    } as any;
    await user.save();
    await syncSellerListingZones(user._id, user.shippingZoneId);
    if (needsReview) {
      await AuditLog.create({
        actorId: user._id,
        action: "seller.shop.apply",
        target: String(user._id),
        meta: { shopKind },
      });
    }
    res.json(toMe(user));
  })
);

meRouter.get(
  "/seller/verification",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    res.json({
      status: user.seller?.verificationStatus || "none",
      reason: user.seller?.rejectionReason || "",
      shopName: user.seller?.shopName || "",
      shopKind: user.seller?.shopKind || null,
      shopDescription: user.seller?.shopDescription || "",
      storeAddress: user.seller?.storeAddress || "",
      soldCategories: user.seller?.soldCategories || [],
      deliveredCommunes: user.seller?.deliveredCommunes || [],
      deliveryDelay: user.seller?.deliveryDelay || "",
      neighborhood: user.seller?.neighborhood || "",
      landmark: user.seller?.landmark || "",
      orangeMoneyPhone: user.seller?.orangeMoneyPhone || "",
      openingTime: user.seller?.openingTime || "",
      closingTime: user.seller?.closingTime || "",
      documents: user.seller?.kycDocuments || [],
      messages: (user.seller?.verificationMessages || []).map((m: any) => ({
        senderId: m.senderId ? String(m.senderId) : null,
        fromAdmin: !!m.fromAdmin,
        body: m.body,
        attachments: m.attachments || [],
        createdAt: m.createdAt,
      })),
    });
  })
);

meRouter.post(
  "/seller/verification/messages",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.seller) throw forbidden();
    user.seller.verificationMessages = user.seller.verificationMessages || [];
    user.seller.verificationMessages.push({
      senderId: user._id as any,
      fromAdmin: false,
      body: req.body.body || req.body.message || "",
      attachments: req.body.attachments || [],
      createdAt: new Date(),
    } as any);
    await user.save();
    res.json({
      status: user.seller.verificationStatus,
      messages: user.seller.verificationMessages,
    });
  })
);

meRouter.post(
  "/seller/verification/documents",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.seller) throw forbidden();
    user.seller.kycDocuments = user.seller.kycDocuments || [];
    user.seller.kycDocuments.push({
      url: req.body.url,
      storageKey: req.body.storageKey,
      mimeType: req.body.mimeType,
      name: req.body.name,
      documentType: req.body.documentType || "other",
      createdAt: new Date(),
    } as any);
    await user.save();
    res.json({ documents: user.seller.kycDocuments });
  })
);

meRouter.post(
  "/seller/particulier/close",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    user.seller = undefined;
    await user.save();
    res.json(toMe(user));
  })
);

meRouter.post(
  "/seller/shop/close",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    user.seller = undefined;
    await user.save();
    res.json(toMe(user));
  })
);

meRouter.post(
  "/seller/downgrade-to-particulier",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    user.seller = {
      kind: "particulier",
      shopKind: null,
      verificationStatus: "approved",
      listingDestination: "SECONDE_MAIN",
      shopName: user.name,
    } as any;
    await user.save();
    res.json(toMe(user));
  })
);

meRouter.patch(
  "/seller/bundle-settings",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.seller) throw forbidden();
    if (req.body.bundleEnabled != null) user.seller.bundleEnabled = req.body.bundleEnabled;
    if (req.body.bundleMinItems != null) user.seller.bundleMinItems = req.body.bundleMinItems;
    if (req.body.bundleDiscountPercent != null) {
      user.seller.bundleDiscountPercent = req.body.bundleDiscountPercent;
    }
    await user.save();
    res.json(toMe(user));
  })
);

meRouter.post(
  "/seller/tools/vacation",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.seller) throw forbidden();
    user.seller.vacationEnabled = !!req.body.enabled;
    user.seller.vacationStartsAt = req.body.startsAt ? new Date(req.body.startsAt) : null;
    user.seller.vacationEndsAt = req.body.endsAt ? new Date(req.body.endsAt) : null;
    await user.save();
    res.json(toMe(user));
  })
);

meRouter.get(
  "/seller/tools/library",
  ah(async (req, res) => {
    const items = await LibraryItem.find({ sellerId: (req as AuthedRequest).userId });
    res.json(items.map((i) => ({ id: String(i._id), ...i.toObject() })));
  })
);

meRouter.post(
  "/seller/tools/library",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const caps = computeCapabilities({
      kind: user.seller?.kind,
      shopKind: user.seller?.shopKind ?? null,
      verificationStatus: user.seller?.verificationStatus,
    });
    if (!caps.productLibrary) {
      throw forbidden(
        "FORBIDDEN",
        "Bibliothèque disponible après validation de ton commerce local"
      );
    }
    const item = await LibraryItem.create({
      sellerId: user._id,
      title: req.body.title,
      description: req.body.description,
      categoryId: req.body.categoryId || null,
      payloadJson: req.body.payloadJson || {},
    });
    res.json({ id: String(item._id), ...item.toObject() });
  })
);

meRouter.post(
  "/seller/tools/excel-import",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const caps = computeCapabilities({
      kind: user.seller?.kind,
      shopKind: user.seller?.shopKind ?? null,
      verificationStatus: user.seller?.verificationStatus,
    });
    if (!caps.excelImport) {
      throw forbidden(
        "FORBIDDEN",
        "Import Excel disponible après validation de ta boutique"
      );
    }
    res.json({
      status: "queued",
      objectKey: req.body.objectKey,
      message: "Fichier enregistré sur UploadThing.",
    });
  })
);

meRouter.get(
  "/kyc",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    res.json(user.kyc || { status: "none", documents: [] });
  })
);

meRouter.post(
  "/kyc",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    user.kyc = {
      ...(user.kyc || {}),
      status: "pending",
      note: req.body?.note || user.kyc?.note || "",
      documents: user.kyc?.documents || [],
    } as any;
    await user.save();
    res.json(user.kyc);
  })
);

meRouter.post(
  "/kyc/documents",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.kyc) user.kyc = { status: "pending", note: "", documents: [] } as any;
    user.kyc!.documents.push({
      documentType: req.body.documentType,
      storageKey: req.body.storageKey,
      mimeType: req.body.mimeType,
    });
    await user.save();
    res.json(user.kyc);
  })
);

export const orgRouter = Router();

orgRouter.get(
  "/:orgId/kyc",
  requireAuth,
  ah(async (req, res) => {
    const doc = await OrgKyc.findById(req.params.orgId);
    res.json(doc || { status: "none" });
  })
);

orgRouter.post(
  "/:orgId/kyc",
  requireAuth,
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const doc = await OrgKyc.findOneAndUpdate(
      { userId: user._id },
      { status: "pending", note: req.body?.note || "", orgName: user.seller?.shopName },
      { upsert: true, new: true }
    );
    res.json(doc);
  })
);

orgRouter.post(
  "/:orgId/kyc/documents",
  requireAuth,
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const doc = await OrgKyc.findOneAndUpdate(
      { userId: user._id },
      {
        $push: {
          documents: {
            documentType: req.body.documentType,
            storageKey: req.body.storageKey,
            mimeType: req.body.mimeType,
          },
        },
      },
      { upsert: true, new: true }
    );
    res.json(doc);
  })
);
