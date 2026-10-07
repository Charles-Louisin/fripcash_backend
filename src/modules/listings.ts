import { Router } from "express";
import { z } from "zod";
import { Listing } from "../models/listing.js";
import { Category } from "../models/catalog.js";
import { User } from "../models/user.js";
import { Comment, Review, SellerLike } from "../models/social.js";
import { optionalAuth, requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import {
  badRequest,
  forbidden,
  notFound,
} from "../utils/http-error.js";
import { computeCapabilities, isDirectoryVisible } from "../utils/capabilities.js";
import { previewBuyerPrice, rateForShopKind } from "../utils/pricing.js";
import { getSettings } from "../services/notify.js";
import { param, sid } from "../utils/ids.js";
import { toListing } from "../serializers.js";
import {
  listingsForSeller,
  reviewStatsForListings,
  reviewStatsForSellers,
  toPublicShop,
} from "../services/seller-public.js";

export const listingsRouter = Router();

async function hydrate(doc: any) {
  const seller = await User.findById(doc.sellerId).lean();
  const stats = await reviewStatsForSellers([doc.sellerId]);
  return toListing(doc, seller, stats.get(String(doc.sellerId)));
}

function csv(query: unknown) {
  return String(query || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRx(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

listingsRouter.get(
  "/",
  optionalAuth,
  ah(async (req, res) => {
    const filter: Record<string, unknown> = { status: "ACTIVE" };
    const destinations = csv(req.query.destination);
    if (destinations.length === 1) filter.destination = destinations[0];
    else if (destinations.length > 1) filter.destination = { $in: destinations };
    const categoryIds = csv(req.query.categoryId);
    if (categoryIds.length === 1) filter.categoryId = categoryIds[0];
    else if (categoryIds.length > 1) filter.categoryId = { $in: categoryIds };
    const mine = req.query.mine === "1" || req.query.sellerId;
    const authed = req as AuthedRequest;
    if (mine && authed.userId) {
      delete filter.status;
      filter.sellerId = req.query.sellerId || authed.userId;
    }

    const createdWithinDays = Number(req.query.createdWithinDays);
    const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : null;
    const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : null;
    const createdAt: Record<string, Date> = {};
    if (createdWithinDays > 0) {
      createdAt.$gte = new Date(Date.now() - createdWithinDays * 24 * 60 * 60 * 1000);
    }
    if (dateFrom && !Number.isNaN(dateFrom.getTime())) createdAt.$gte = dateFrom;
    if (dateTo && !Number.isNaN(dateTo.getTime())) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      createdAt.$lte = end;
    }
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    const shopKinds = csv(req.query.shopKind).map((s) => s.toLowerCase());
    const sellerKind = String(req.query.sellerKind || "").toLowerCase();
    if (!mine && (shopKinds.length || sellerKind)) {
      const sellerFilter: Record<string, unknown> = { seller: { $ne: null } };
      if (shopKinds.includes("particulier") && shopKinds.length === 1) {
        sellerFilter["seller.kind"] = "particulier";
      } else if (sellerKind === "particulier" && !shopKinds.length) {
        sellerFilter["seller.kind"] = "particulier";
      } else if (sellerKind === "boutique" && !shopKinds.length) {
        sellerFilter["seller.kind"] = "boutique";
      } else if (shopKinds.length) {
        const or: Record<string, unknown>[] = [];
        if (shopKinds.includes("particulier")) or.push({ "seller.kind": "particulier" });
        const boutiqueKinds = shopKinds.filter((k) =>
          ["standard", "proximite", "enseigne"].includes(k)
        );
        if (boutiqueKinds.length) {
          or.push({
            "seller.kind": "boutique",
            "seller.shopKind": { $in: boutiqueKinds },
          });
        }
        if (or.length) sellerFilter.$or = or;
      }
      const sellers = await User.find(sellerFilter).select("_id").lean();
      filter.sellerId = { $in: sellers.map((s) => s._id) };
    }

    const q = String(req.query.q || "").trim();
    if (q) {
      const rx = new RegExp(escapeRx(q), "i");
      const [cats, namedSellers] = await Promise.all([
        Category.find({
          $or: [{ nameFr: rx }, { nameEn: rx }, { slug: rx }],
        })
          .select("_id")
          .lean(),
        User.find({
          $or: [{ "seller.shopName": rx }, { name: rx }, { "seller.bio": rx }],
        })
          .select("_id")
          .lean(),
      ]);
      const textOr: Record<string, unknown>[] = [
        { title: rx },
        { description: rx },
        { conditionNote: rx },
      ];
      if (cats.length) textOr.push({ categoryId: { $in: cats.map((c) => c._id) } });
      if (namedSellers.length) {
        textOr.push({ sellerId: { $in: namedSellers.map((s) => s._id) } });
      }
      filter.$or = textOr;
    }

    const rows = await Listing.find(filter).sort({ createdAt: -1 }).lean();
    const sellers = await User.find({ _id: { $in: rows.map((r) => r.sellerId) } }).lean();
    const map = new Map(sellers.map((s) => [String(s._id), s]));
    const visible = mine
      ? rows
      : rows.filter((r) =>
          isDirectoryVisible({
            shopKind: map.get(String(r.sellerId))?.seller?.shopKind ?? null,
            verificationStatus:
              map.get(String(r.sellerId))?.seller?.verificationStatus,
          })
        );
    const [stats, listingStats] = await Promise.all([
      reviewStatsForSellers(visible.map((r) => r.sellerId)),
      reviewStatsForListings(visible.map((r) => r._id)),
    ]);
    const minListingRating = Number(req.query.minListingRating) || 0;
    const minSellerRating = Number(req.query.minSellerRating) || 0;
    const payload = visible
      .map((r) =>
        toListing(r, map.get(String(r.sellerId)), {
          ...stats.get(String(r.sellerId)),
          listingRating: listingStats.get(String(r._id))?.rating,
          listingReviewsCount: listingStats.get(String(r._id))?.reviewsCount,
        })
      )
      .filter((item) => {
        if (minListingRating > 0 && (item.listingRating || 0) < minListingRating) {
          return false;
        }
        if (
          minSellerRating > 0 &&
          (item.sellerProfile?.rating || 0) < minSellerRating
        ) {
          return false;
        }
        return true;
      });
    res.json(payload);
  })
);

listingsRouter.get(
  "/:id",
  optionalAuth,
  ah(async (req, res) => {
    const row = await Listing.findById(req.params.id);
    if (!row) throw notFound("Annonce introuvable");
    const seller = await User.findById(row.sellerId).lean();
    const authed = req as AuthedRequest;
    const isOwner = !!authed.userId && sid(row.sellerId) === sid(authed.userId);
    if (
      !isOwner &&
      !isDirectoryVisible({
        shopKind: seller?.seller?.shopKind ?? null,
        verificationStatus: seller?.seller?.verificationStatus,
      })
    ) {
      throw notFound("Annonce introuvable");
    }
    const stats = await reviewStatsForSellers([row.sellerId]);
    res.json(toListing(row, seller, stats.get(String(row.sellerId))));
  })
);

listingsRouter.post(
  "/",
  requireAuth,
  requireAudience("CONSUMER"),
  validate(
    z.object({
      title: z.string().min(2),
      description: z.string().optional(),
      netPriceGnf: z.number().int().min(1),
      quantity: z.number().int().min(1),
      destination: z.enum([
        "SECONDE_MAIN",
        "ARTICLES_NEUFS",
        "QUARTIER_BOUTIQUES",
        "ENSEIGNES",
      ]),
      categoryId: z.string().optional(),
      zoneId: z.string().optional(),
      conditionNote: z.string().optional(),
      negotiable: z.boolean().optional(),
      discountEnabled: z.boolean().optional(),
      compareAtPriceGnf: z.number().nullable().optional(),
    })
  ),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const caps = computeCapabilities({
      kind: user.seller?.kind,
      shopKind: user.seller?.shopKind ?? null,
      verificationStatus: user.seller?.verificationStatus,
    });
    if (!caps.createListing) {
      throw forbidden("FORBIDDEN", "Profil vendeur non autorisé à publier");
    }
    const lockedDestination = user.seller?.listingDestination;
    if (lockedDestination && req.body.destination !== lockedDestination) {
      throw badRequest(
        "INVALID_DESTINATION",
        "Cette destination n’est pas disponible pour ton type de compte"
      );
    }
    const settings = await getSettings();
    const rate =
      user.seller?.shopKind === "proximite"
        ? settings.commissionRateProximite
        : settings.commissionRateStandard;
    const priceGnf = previewBuyerPrice(req.body.netPriceGnf, rate);
    const row = await Listing.create({
      sellerId: user._id,
      title: req.body.title,
      description: req.body.description ?? null,
      netPriceGnf: req.body.netPriceGnf,
      priceGnf,
      commissionRate: rate,
      commissionAmountGnf: priceGnf - req.body.netPriceGnf,
      quantity: req.body.quantity,
      destination: user.seller?.listingDestination || req.body.destination,
      categoryId: req.body.categoryId || null,
      zoneId: req.body.zoneId || null,
      conditionNote: req.body.conditionNote ?? null,
      negotiable: !!req.body.negotiable,
      discountEnabled: !!req.body.discountEnabled,
      compareAtPriceGnf: req.body.compareAtPriceGnf ?? null,
      status: "ACTIVE",
      publishedAt: new Date(),
    });
    res.json(await hydrate(row));
  })
);

listingsRouter.patch(
  "/:id",
  requireAuth,
  requireAudience("CONSUMER"),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const row = await Listing.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== sid(user._id)) throw forbidden();
    const patch = { ...req.body };
    if (patch.netPriceGnf) {
      const rate = row.commissionRate || rateForShopKind(user.seller?.shopKind);
      patch.priceGnf = previewBuyerPrice(patch.netPriceGnf, rate);
      patch.commissionRate = rate;
      patch.commissionAmountGnf = patch.priceGnf - patch.netPriceGnf;
    }
    Object.assign(row, patch);
    await row.save();
    res.json(await hydrate(row));
  })
);

listingsRouter.delete(
  "/:id",
  requireAuth,
  requireAudience("CONSUMER"),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const row = await Listing.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== sid(user._id)) throw forbidden();
    await row.deleteOne();
    res.json({ status: true });
  })
);

listingsRouter.post(
  "/:id/media",
  requireAuth,
  ah(async (req, res) => {
    const row = await Listing.findById(req.params.id);
    if (!row) throw notFound();
    const media = {
      storageKey: req.body.publicId || req.body.storageKey || req.body.url,
      url: req.body.url,
      mimeType: req.body.mimeType || "image/jpeg",
      sortOrder: req.body.sortOrder ?? row.media.length,
    };
    row.media.push(media as any);
    await row.save();
    const last = row.media[row.media.length - 1];
    res.json({
      id: sid(last._id),
      listingId: sid(row._id),
      storageKey: last.storageKey,
      url: last.url,
      mimeType: last.mimeType,
      sortOrder: last.sortOrder,
    });
  })
);

listingsRouter.patch(
  "/:id/media/:mediaId",
  requireAuth,
  ah(async (req, res) => {
    const row = await Listing.findById(req.params.id);
    if (!row) throw notFound();
    const media = row.media.id(param(req.params.mediaId));
    if (!media) throw notFound();
    if (req.body.url) media.url = req.body.url;
    if (req.body.publicId) media.storageKey = req.body.publicId;
    if (req.body.storageKey) media.storageKey = req.body.storageKey;
    if (req.body.mimeType) media.mimeType = req.body.mimeType;
    if (req.body.sortOrder !== undefined) media.sortOrder = Number(req.body.sortOrder);
    await row.save();
    res.json({
      id: sid(media._id),
      listingId: sid(row._id),
      storageKey: media.storageKey,
      url: media.url,
      mimeType: media.mimeType,
      sortOrder: media.sortOrder,
    });
  })
);

listingsRouter.delete(
  "/:id/media/:mediaId",
  requireAuth,
  ah(async (req, res) => {
    const row = await Listing.findById(req.params.id);
    if (!row) throw notFound();
    row.media.pull({ _id: req.params.mediaId });
    await row.save();
    res.json({ status: true });
  })
);

listingsRouter.get(
  "/:id/comments",
  ah(async (req, res) => {
    const rows = await Comment.find({ listingId: req.params.id, hidden: false }).lean();
    res.json(
      rows.map((c) => ({
        id: sid(c._id),
        body: c.body,
        userId: sid(c.userId),
        parentId: c.parentId ? sid(c.parentId) : null,
        createdAt: c.createdAt,
      }))
    );
  })
);

listingsRouter.post(
  "/:id/comments",
  requireAuth,
  validate(z.object({ body: z.string().min(1), parentId: z.string().optional() })),
  ah(async (req, res) => {
    const row = await Comment.create({
      listingId: req.params.id,
      userId: (req as AuthedRequest).userId,
      body: req.body.body,
      parentId: req.body.parentId || null,
    });
    res.json({ id: sid(row._id), body: row.body, createdAt: row.createdAt });
  })
);

listingsRouter.get(
  "/:id/reviews",
  ah(async (req, res) => {
    const rows = await Review.find({ listingId: req.params.id, hidden: false }).lean();
    res.json(
      rows.map((r) => ({
        id: sid(r._id),
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
      }))
    );
  })
);

export const reviewsRouter = Router();

reviewsRouter.get(
  "/:id/public",
  optionalAuth,
  ah(async (req, res) => {
    const user = await User.findById(req.params.id).lean();
    if (!user?.seller) throw notFound("Boutique introuvable");
    if (user.seller.verificationStatus !== "approved" && user.seller.kind !== "particulier") {
      throw notFound("Boutique introuvable");
    }
    const stats = await reviewStatsForSellers([user._id]);
    const listings = await listingsForSeller(user._id);
    let likedByMe = false;
    const uid = (req as AuthedRequest).userId;
    if (uid) {
      likedByMe = !!(await SellerLike.findOne({ userId: uid, sellerId: user._id }));
    }
    res.json(
      toPublicShop(user, stats.get(String(user._id)), {
        listings,
        likedByMe,
      })
    );
  })
);

reviewsRouter.post(
  "/:id/like",
  requireAuth,
  ah(async (req, res) => {
    const seller = await User.findById(req.params.id);
    if (!seller?.seller) throw notFound("Boutique introuvable");
    const uid = (req as AuthedRequest).userId!;
    const existing = await SellerLike.findOne({ userId: uid, sellerId: seller._id });
    let liked = false;
    if (existing) {
      await existing.deleteOne();
      seller.seller.likesCount = Math.max(0, (seller.seller.likesCount || 0) - 1);
    } else {
      await SellerLike.create({ userId: uid, sellerId: seller._id });
      seller.seller.likesCount = (seller.seller.likesCount || 0) + 1;
      liked = true;
    }
    await seller.save();
    res.json({ liked, likesCount: seller.seller.likesCount });
  })
);

reviewsRouter.get(
  "/:sellerProfileId/reviews",
  ah(async (req, res) => {
    const rows = await Review.find({
      sellerId: req.params.sellerProfileId,
      hidden: false,
    }).lean();
    res.json(
      rows.map((r) => ({
        id: sid(r._id),
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
      }))
    );
  })
);

export const unusedBad = badRequest;
