import { Router } from "express";
import { z } from "zod";
import { User } from "../models/user.js";
import { OrgKyc } from "../models/ops.js";
import { LibraryItem, Listing } from "../models/listing.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden } from "../utils/http-error.js";
import { destinationForSeller, previewBuyerPrice } from "../utils/pricing.js";
import { computeCapabilities } from "../utils/capabilities.js";
import { toMe } from "../serializers.js";
import { AuditLog } from "../models/ops.js";
import { parseGnMobile } from "../services/gn-phone.js";
import {
  requireAccountShippingZone,
  setUserShippingZone,
  syncSellerListingZones,
} from "../utils/shipping-zone.js";
import ExcelJS from "exceljs";
import { Category } from "../models/catalog.js";
import { getSettings } from "../services/notify.js";

const MAX_IMPORT_ROWS = 200;

const HEADER_ALIASES: Record<string, string> = {
  titre: "titre",
  title: "titre",
  nom: "titre",
  article: "titre",
  produit: "titre",
  prix: "prix",
  price: "prix",
  prixnet: "prix",
  prixgnf: "prix",
  quantite: "quantite",
  qte: "quantite",
  quantity: "quantite",
  stock: "quantite",
  description: "description",
  categorie: "categorie",
  category: "categorie",
  etat: "etat",
  condition: "etat",
  negociable: "negociable",
  image: "image",
  photo: "image",
  imageurl: "image",
};

function normHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const v = value as any;
    if (v.text) return String(v.text).trim();
    if (v.hyperlink) return String(v.hyperlink).trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join("").trim();
  }
  return String(value).trim();
}

const IMPORT_HOSTS = ["utfs.io", "ufs.sh", "uploadthing.com"];

async function importFileBuffer(body: any): Promise<Buffer> {
  if (body?.base64) return Buffer.from(String(body.base64), "base64");
  const raw = String(body?.url || body?.objectKey || "");
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const allowed =
    url?.protocol === "https:" &&
    IMPORT_HOSTS.some((host) => url!.hostname === host || url!.hostname.endsWith(`.${host}`));
  if (!url || !allowed) throw badRequest("FILE_REQUIRED", "Ajoute un fichier Excel (.xlsx) ou CSV.");
  const response = await fetch(url);
  if (!response.ok) throw badRequest("FILE_UNREACHABLE", "Fichier introuvable, renvoie-le.");
  const size = Number(response.headers.get("content-length") || 0);
  if (size > 8 * 1024 * 1024) throw badRequest("FILE_TOO_LARGE", "Fichier trop lourd (8 Mo maximum).");
  return Buffer.from(await response.arrayBuffer());
}

async function readSheetRows(buffer: Buffer, csv: boolean) {
  const workbook = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    if (csv) {
      const { Readable } = await import("node:stream");
      sheet = await workbook.csv.read(Readable.from(buffer));
    } else {
      await workbook.xlsx.load(buffer as any);
      sheet = workbook.worksheets[0];
    }
  } catch {
    throw badRequest("INVALID_FILE", "Fichier illisible. Utilise un fichier .xlsx ou .csv.");
  }
  if (!sheet) return [];
  const keys: (string | null)[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    keys[col] = HEADER_ALIASES[normHeader(cellText(cell.value))] ?? null;
  });
  if (!keys.includes("titre") || !keys.includes("prix")) {
    throw badRequest(
      "MISSING_COLUMNS",
      "La première ligne doit contenir au moins les colonnes « Titre » et « Prix »."
    );
  }
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const out: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = keys[col];
      if (key) out[key] = cell.value;
    });
    if (Object.values(out).some((v) => cellText(v))) rows.push(out);
  });
  return rows;
}

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
    if ("startsAt" in req.body) {
      user.seller.vacationStartsAt = req.body.startsAt ? new Date(req.body.startsAt) : null;
    }
    if ("endsAt" in req.body) {
      user.seller.vacationEndsAt = req.body.endsAt ? new Date(req.body.endsAt) : null;
    }
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
    if (!caps.excelImport || !caps.createListing) {
      throw forbidden(
        "FORBIDDEN",
        "Import Excel disponible après validation de ta boutique"
      );
    }
    const isCsv = String(req.body?.filename || "").toLowerCase().endsWith(".csv");
    const rows = await readSheetRows(await importFileBuffer(req.body), isCsv);
    if (!rows.length) throw badRequest("EMPTY_FILE", "Le fichier ne contient aucune ligne d’article.");
    if (rows.length > MAX_IMPORT_ROWS) {
      throw badRequest("TOO_MANY_ROWS", `${MAX_IMPORT_ROWS} articles maximum par import.`);
    }

    const zoneId = requireAccountShippingZone(user);
    const settings = await getSettings();
    const rate =
      user.seller?.shopKind === "proximite"
        ? settings.commissionRateProximite
        : settings.commissionRateStandard;
    const destination =
      user.seller?.listingDestination ||
      destinationForSeller(user.seller?.kind as any, user.seller?.shopKind) ||
      "SECONDE_MAIN";
    const categories = await Category.find({}).select("nameFr").lean();
    const categoryByName = new Map(categories.map((c: any) => [normHeader(c.nameFr), c._id]));

    const errors: { row: number; message: string }[] = [];
    let created = 0;
    for (const [index, row] of rows.entries()) {
      const line = index + 2;
      const title = cellText(row.titre);
      const net = Math.round(Number(cellText(row.prix).replace(/[^\d.]/g, "")));
      if (title.length < 2) {
        errors.push({ row: line, message: "Titre manquant" });
        continue;
      }
      if (!net || net < 1) {
        errors.push({ row: line, message: "Prix invalide" });
        continue;
      }
      const quantity = Math.max(1, Math.round(Number(cellText(row.quantite)) || 1));
      const categoryName = cellText(row.categorie);
      const categoryId = categoryName ? categoryByName.get(normHeader(categoryName)) ?? null : null;
      const priceGnf = previewBuyerPrice(net, rate);
      const image = cellText(row.image);
      try {
        await Listing.create({
          sellerId: user._id,
          title,
          description: cellText(row.description) || null,
          netPriceGnf: net,
          priceGnf,
          commissionRate: rate,
          commissionAmountGnf: priceGnf - net,
          quantity,
          destination,
          categoryId,
          zoneId,
          conditionNote: cellText(row.etat) || null,
          negotiable: /^(oui|yes|true|1|x)$/i.test(cellText(row.negociable)),
          media: /^https?:\/\//i.test(image)
            ? [{ storageKey: image, url: image, mimeType: "image/jpeg", sortOrder: 0 }]
            : [],
          status: "ACTIVE",
          publishedAt: new Date(),
        });
        created += 1;
      } catch (e: any) {
        errors.push({ row: line, message: e?.message || "Ligne invalide" });
      }
    }
    res.json({ status: "done", created, skipped: errors.length, errors: errors.slice(0, 20) });
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
