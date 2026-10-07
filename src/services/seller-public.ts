import { Listing } from "../models/listing.js";
import { Review } from "../models/social.js";
import { sid } from "../utils/ids.js";
import { toListing } from "../serializers.js";

export async function reviewStatsForSellers(ids: unknown[]) {
  const objectIds = ids.filter(Boolean);
  if (!objectIds.length) return new Map<string, { rating: number; reviewsCount: number }>();
  const rows = await Review.aggregate([
    { $match: { sellerId: { $in: objectIds }, hidden: { $ne: true } } },
    {
      $group: {
        _id: "$sellerId",
        rating: { $avg: "$rating" },
        reviewsCount: { $sum: 1 },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id),
      {
        rating: Math.round((r.rating || 0) * 10) / 10,
        reviewsCount: r.reviewsCount || 0,
      },
    ])
  );
}

export async function reviewStatsForListings(ids: unknown[]) {
  const objectIds = ids.filter(Boolean);
  if (!objectIds.length) return new Map<string, { rating: number; reviewsCount: number }>();
  const rows = await Review.aggregate([
    { $match: { listingId: { $in: objectIds }, hidden: { $ne: true } } },
    {
      $group: {
        _id: "$listingId",
        rating: { $avg: "$rating" },
        reviewsCount: { $sum: 1 },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id),
      {
        rating: Math.round((r.rating || 0) * 10) / 10,
        reviewsCount: r.reviewsCount || 0,
      },
    ])
  );
}

export function toPublicShop(
  user: any,
  stats?: { rating: number; reviewsCount: number },
  extras: Record<string, unknown> = {}
) {
  return {
    id: sid(user._id),
    shopName: user.seller?.shopName || user.name || "Boutique",
    sellerKind: user.seller?.kind || null,
    shopKind: user.seller?.shopKind || null,
    avatarUrl: user.avatarUrl || "",
    coverUrl: user.seller?.coverUrl || "",
    bio: user.seller?.shopDescription || user.seller?.bio || user.bio || "",
    rating: stats?.rating || 0,
    reviewsCount: stats?.reviewsCount || 0,
    likesCount: user.seller?.likesCount || 0,
    createdAt: user.seller?.shopCreatedAt || user.createdAt,
    ...extras,
  };
}

export async function listingsForSeller(sellerId: unknown) {
  const rows = await Listing.find({ sellerId, status: "ACTIVE" })
    .sort({ createdAt: -1 })
    .lean();
  return rows.map((r) => toListing(r));
}
