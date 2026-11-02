import type { User } from "./models/user.js";
import { sid } from "./utils/ids.js";
import { publicMediaUrl } from "./utils/public-url.js";
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
    canBuy:
      user.authAudience !== "ADMIN" &&
      (user.authAudience === "COURIER" || user.canBuy),
    emailVerified: !!user.emailVerified,
    phoneNumberVerified: !!user.phoneNumberVerified,
    avatarUrl: (user as any).avatarUrl || "",
    city: (user as any).city || "",
    bio: (user as any).bio || user.seller?.bio || "",
    shippingZoneId: (user as any).shippingZoneId
      ? sid((user as any).shippingZoneId)
      : null,
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
          bundleEnabled: !!seller.bundleEnabled,
          bundleMinItems: seller.bundleMinItems || 2,
          bundleDiscountPercent: seller.bundleDiscountPercent || 0,
          vacationEnabled: !!seller.vacationEnabled,
          shippingZoneId: (user as any).shippingZoneId
            ? sid((user as any).shippingZoneId)
            : null,
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
    favoritesCount?: number;
  }
) {
  const sellerId = sid(doc.sellerId);
  return {
    id: sid(doc._id),
    favoritesCount: extras?.favoritesCount ?? 0,
    sellerProfileId: sellerId,
    categoryId: doc.categoryId ? sid(doc.categoryId) : null,
    zoneId: doc.zoneId
      ? sid(doc.zoneId)
      : seller?.shippingZoneId
        ? sid(seller.shippingZoneId)
        : null,
    title: doc.title,
    description: doc.description,
    netPriceGnf: doc.netPriceGnf,
    priceGnf: doc.priceGnf,
    commissionRate: doc.commissionRate,
    commissionAmountGnf: doc.commissionAmountGnf,
    quantity: doc.quantity,
    negotiable: doc.negotiable,
    pickupEnabled: !!doc.pickupEnabled,
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
      url: publicMediaUrl(m.url) || publicMediaUrl(m.storageKey) || m.url || null,
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
      vacationEnabled: !!seller?.seller?.vacationEnabled,
      bundleEnabled: !!seller?.seller?.bundleEnabled,
      bundleMinItems: seller?.seller?.bundleMinItems || 2,
      bundleDiscountPercent: seller?.seller?.bundleDiscountPercent || 0,
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
  const images = [
    ...new Set(
      (Array.isArray(extras.images) ? extras.images : [])
        .map((url) => (typeof url === "string" ? publicMediaUrl(url) || url : ""))
        .filter((url): url is string => !!url)
    ),
  ];
  const listing = first
    ? {
        id: first.listingId ? sid(first.listingId) : null,
        title: first.title,
        images,
        media: images.map((url) => ({ url })),
      }
    : { title: "Article", images, media: images.map((url) => ({ url })) };
  return {
    id: sid(doc._id),
    _id: sid(doc._id),
    buyerId: sid(doc.buyerId),
    sellerId: sid(doc.sellerId),
    courierId: doc.courierId ? sid(doc.courierId) : null,
    items: (doc.items || []).map((item: any) => ({
      listingId: item.listingId ? sid(item.listingId) : null,
      title: item.title,
      quantity: item.quantity,
      priceGnf: item.priceGnf,
      netPriceGnf: item.netPriceGnf,
      commissionGnf: item.commissionGnf,
      imageUrl: publicMediaUrl(item.imageUrl) || "",
    })),
    amountGnf: doc.amountGnf,
    amount: doc.amountGnf,
    totalGnf: doc.amountGnf,
    shippingCostGnf: doc.shippingCostGnf,
    shippingCost: doc.shippingCostGnf,
    commissionGnf: doc.commissionGnf,
    commission: doc.commissionGnf,
    status: doc.status,
    escrowStatus:
      doc.escrowStatus === "held" ||
      doc.escrowStatus === "payout_pending" ||
      doc.escrowStatus === "refund_pending"
        ? "blocked"
        : doc.escrowStatus,
    fulfillmentMode: doc.fulfillmentMode,
    paymentMethod: doc.paymentMethod,
    pickupCode: doc.pickupCode || null,
    pickupZoneId: doc.pickupZoneId ? sid(doc.pickupZoneId) : null,
    notifiedCourierIds: (doc.notifiedCourierIds || []).map((id: unknown) => sid(id)),
    disputeReason: doc.disputeReason,
    offerAmountGnf: doc.offerAmountGnf ?? null,
    originalAmountGnf: doc.originalAmountGnf ?? doc.amountGnf,
    offerStatus: doc.offerStatus || "none",
    courierName: doc.courierName,
    buyerConfirmedAt: doc.buyerConfirmedAt || null,
    parentOrderId: doc.parentOrderId ? sid(doc.parentOrderId) : null,
    orderNumber: doc.orderNumber || null,
    payoutStatus: doc.parentOrderId ? doc.payoutStatus || "not_eligible" : null,
    timeline: doc.timeline,
    address: doc.address,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...extras,
    images,
    listing,
    article: listing,
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

/** Retire de la vue d'une commande les étapes réservées à d'autres rôles (notes internes). */
export function scopeOrderView<T extends { timeline?: any[] }>(view: T, role: "buyer" | "seller" | "courier" | "admin"): T {
  if (role === "admin" || !Array.isArray(view.timeline)) return view;
  return {
    ...view,
    timeline: view.timeline
      .map((t) => (t && typeof t.toObject === "function" ? t.toObject() : t))
      .filter((t) => !t?.visibleTo?.length || t.visibleTo.includes(role))
      .map(({ visibleTo: _v, ...t }) => t),
  };
}

function roleOf(view: any, uid: string, audience?: string) {
  if (audience === "ADMIN") return "admin" as const;
  if (view.buyerId === uid) return "buyer" as const;
  if (view.sellerId === uid) return "seller" as const;
  if (view.courierId === uid || audience === "COURIER") return "courier" as const;
  return "buyer" as const;
}

function scopeDeep(body: any, uid: string, audience?: string): any {
  if (Array.isArray(body)) return body.map((x) => scopeDeep(x, uid, audience));
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body.timeline) && ("buyerId" in body || "sellerId" in body)) {
    return scopeOrderView(body, roleOf(body, uid, audience));
  }
  if (Array.isArray(body.orders)) return { ...body, orders: scopeDeep(body.orders, uid, audience) };
  if (body.order && typeof body.order === "object") return { ...body, order: scopeDeep(body.order, uid, audience) };
  return body;
}

/** Middleware : toute commande renvoyée est filtrée selon le rôle de celui qui la consulte. */
export function scopeOrderResponses(req: any, res: any, next: () => void) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(scopeDeep(body, String(req.userId || ""), req.audience));
  next();
}
