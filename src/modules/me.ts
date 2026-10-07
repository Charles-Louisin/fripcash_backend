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
    await user.save();
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
      description: z.string().optional(),
      coverUrl: z.string().max(2000).optional(),
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
        .optional(),
    })
  ),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (
      user.seller?.kind === "boutique" &&
      user.seller.verificationStatus !== "rejected"
    ) {
      throw badRequest(
        "ALREADY_SHOP",
        "Tu as déjà une boutique ou une enseigne sur ce compte."
      );
    }
    const shopKind = req.body.shopKind.toLowerCase() as "standard" | "proximite" | "enseigne";
    const needsReview = shopKind === "proximite" || shopKind === "enseigne";
    user.seller = {
      kind: "boutique",
      shopKind,
      shopName: req.body.name,
      shopDescription: req.body.description || "",
      bio: req.body.description || "",
      coverUrl: req.body.coverUrl || "",
      likesCount: 0,
      shopCreatedAt: new Date(),
      kycDocuments: (req.body.documents || []).map((d: any) => ({
        ...d,
        createdAt: new Date(),
      })),
      verificationMessages: [],
      verificationStatus: needsReview ? "pending" : "approved",
      listingDestination: destinationForSeller("boutique", shopKind),
    } as any;
    await user.save();
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
      message: "Import enregistré — créez les annonces depuis le fichier UploadThing côté UI",
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
