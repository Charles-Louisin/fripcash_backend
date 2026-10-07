import type { User } from "./models/user.js";
import { sid } from "./utils/ids.js";
import {
  allowedDestinations,
  computeCapabilities,
} from "./utils/capabilities.js";

export function toAuthUser(user: InstanceType<typeof User>) {
  return {
    id: sid(user._id),
    name: user.name || user.phone || user.email || "",
    email: user.email || "",
    phoneNumber: user.phone || "",
    phoneNumberVerified: !!user.phoneNumberVerified,
    emailVerified: !!user.emailVerified,
    preferredLocale: user.preferredLocale || "FR",
    userKind: user.isAdmin
      ? "ADMIN"
      : user.authAudience === "COURIER"
        ? "COURIER"
        : user.seller?.kind || "CONSUMER",
    authAudience: user.authAudience,
  };
}

export function toMe(user: InstanceType<typeof User>) {
  const seller = user.seller;
  const caps = computeCapabilities({
    kind: seller?.kind,
    shopKind: seller?.shopKind ?? null,
    verificationStatus: seller?.verificationStatus,
  });
  return {
    id: sid(user._id),
    phone: user.phone,
    email: user.email,
    displayName: user.name || user.phone || user.email || "",
    preferredLocale: user.preferredLocale || "FR",
    canBuy: user.canBuy && user.authAudience === "CONSUMER",
    emailVerified: !!user.emailVerified,
    avatarUrl: (user as any).avatarUrl || "",
    city: (user as any).city || "",
    bio: (user as any).bio || user.seller?.bio || "",
    seller: seller
      ? {
          profileId: sid(user._id),
          id: sid(user._id),
          kind: seller.kind,
          shopKind: seller.shopKind ?? null,
          shopName: seller.shopName || user.name || "",
          shopDescription: seller.shopDescription || "",
          coverUrl: seller.coverUrl || "",
          likesCount: seller.likesCount || 0,
          verificationStatus: seller.verificationStatus,
          listingDestination: seller.listingDestination,
          allowedDestinations: allowedDestinations(seller.kind, seller.shopKind ?? null),
          capabilities: caps,
        }
      : null,
    courier: user.courier
      ? {
          verificationStatus: user.courier.verificationStatus,
          isAvailable: user.courier.isAvailable,
          zoneId: user.courier.zoneId ? sid(user.courier.zoneId) : null,
          zoneIds: [
            ...new Set(
              [
                ...(user.courier.zoneIds || []).map((z: unknown) => sid(z)),
                user.courier.zoneId ? sid(user.courier.zoneId) : null,
              ].filter(Boolean) as string[]
            ),
          ],
        }
      : null,
    isAdmin: !!user.isAdmin,
  };
}

export function toCategory(doc: any) {
  return {
    id: sid(doc._id),
    parentId: doc.parentId ? sid(doc.parentId) : null,
    nameFr: doc.nameFr,
    nameEn: doc.nameEn,
    slug: doc.slug,
    destination: doc.destination,
    sortOrder: doc.sortOrder,
    isActive: doc.isActive,
    imageUrl: doc.imageUrl,
    imagePublicId: doc.imagePublicId,
  };
}

export function toZone(doc: any) {
  return {
    id: sid(doc._id),
    code: doc.code,
    nameFr: doc.nameFr,
    nameEn: doc.nameEn,
    isActive: doc.isActive,
  };
}

export function toListing(
  doc: any,
  seller?: any,
  extras?: {
    rating?: number;
    reviewsCount?: number;
    listingRating?: number;
    listingReviewsCount?: number;
  }
) {
  const sellerId = sid(doc.sellerId);
  return {
    id: sid(doc._id),
    sellerProfileId: sellerId,
    categoryId: doc.categoryId ? sid(doc.categoryId) : null,
    zoneId: doc.zoneId ? sid(doc.zoneId) : null,
    title: doc.title,
    description: doc.description,
    netPriceGnf: doc.netPriceGnf,
    priceGnf: doc.priceGnf,
    commissionRate: doc.commissionRate,
    commissionAmountGnf: doc.commissionAmountGnf,
    quantity: doc.quantity,
    negotiable: doc.negotiable,
    discountEnabled: doc.discountEnabled,
    compareAtPriceGnf: doc.compareAtPriceGnf,
    status: doc.status,
    destination: doc.destination,
    conditionNote: doc.conditionNote,
    publishedAt: doc.publishedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    media: (doc.media || []).map((m: any) => ({
      id: sid(m._id),
      listingId: sid(doc._id),
      storageKey: m.storageKey,
      url: m.url,
      mimeType: m.mimeType,
      sortOrder: m.sortOrder,
    })),
    sellerProfile: {
      id: sellerId,
      userId: sellerId,
      displayName: seller?.seller?.shopName || seller?.name || null,
      shopName: seller?.seller?.shopName || seller?.name || null,
      avatarUrl: seller?.avatarUrl || "",
      bio: seller?.seller?.bio || null,
      sellerKind: seller?.seller?.kind || null,
      shopKind: seller?.seller?.shopKind || null,
      verificationStatus: seller?.seller?.verificationStatus || null,
      rating: extras?.rating || 0,
      reviewsCount: extras?.reviewsCount || 0,
    },
    listingRating: extras?.listingRating || 0,
    listingReviewsCount: extras?.listingReviewsCount || 0,
    category:
      doc.categoryId && typeof doc.categoryId === "object" && doc.categoryId.nameFr
        ? {
            id: sid(doc.categoryId._id),
            nameFr: doc.categoryId.nameFr,
            nameEn: doc.categoryId.nameEn,
          }
        : undefined,
  };
}

export function toOrder(doc: any, extras: Record<string, unknown> = {}) {
  const first = doc.items?.[0];
  const listing = first
    ? { id: first.listingId ? sid(first.listingId) : null, title: first.title }
    : { title: "Article" };
  return {
    id: sid(doc._id),
    _id: sid(doc._id),
    buyerId: sid(doc.buyerId),
    sellerId: sid(doc.sellerId),
    courierId: doc.courierId ? sid(doc.courierId) : null,
    listing,
    article: listing,
    items: doc.items,
    amountGnf: doc.amountGnf,
    amount: doc.amountGnf,
    totalGnf: doc.amountGnf,
    shippingCostGnf: doc.shippingCostGnf,
    shippingCost: doc.shippingCostGnf,
    commissionGnf: doc.commissionGnf,
    commission: doc.commissionGnf,
    status: doc.status,
    escrowStatus: doc.escrowStatus === "held" ? "blocked" : doc.escrowStatus,
    fulfillmentMode: doc.fulfillmentMode,
    paymentMethod: doc.paymentMethod,
    pickupCode: null,
    pickupZoneId: doc.pickupZoneId ? sid(doc.pickupZoneId) : null,
    notifiedCourierIds: (doc.notifiedCourierIds || []).map((id: unknown) => sid(id)),
    disputeReason: doc.disputeReason,
    offerAmountGnf: doc.offerAmountGnf ?? null,
    originalAmountGnf: doc.originalAmountGnf ?? doc.amountGnf,
    offerStatus: doc.offerStatus || "none",
    courierName: doc.courierName,
    timeline: doc.timeline,
    address: doc.address,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...extras,
  };
}

export function toAdminUser(user: InstanceType<typeof User>) {
  return {
    id: sid(user._id),
    name: user.name || "",
    email: user.email || "",
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    phoneNumber: user.phone,
    phone: user.phone,
    phoneNumberVerified: user.phoneNumberVerified,
    role: user.isAdmin ? "admin" : user.authAudience === "COURIER" ? "courier" : "user",
    banned: user.banned,
    banReason: user.banReason,
    preferredLocale: user.preferredLocale,
    userKind: user.seller?.kind || (user.isAdmin ? "admin" : user.authAudience === "COURIER" ? "courier" : "acheteur"),
    authAudience: user.authAudience,
    seller: user.seller
      ? {
          kind: user.seller.kind,
          shopKind: user.seller.shopKind,
          shopName: user.seller.shopName,
          verificationStatus: user.seller.verificationStatus,
        }
      : null,
    courier: user.courier
      ? {
          isAvailable: user.courier.isAvailable,
          vehicle: user.courier.vehicle,
          plate: user.courier.plate,
          verificationStatus: user.courier.verificationStatus,
          zoneId: user.courier.zoneId ? sid(user.courier.zoneId) : null,
          zoneIds: [
            ...new Set(
              [
                ...(user.courier.zoneIds || []).map((z: unknown) => sid(z)),
                user.courier.zoneId ? sid(user.courier.zoneId) : null,
              ].filter(Boolean) as string[]
            ),
          ],
        }
      : null,
  };
}
