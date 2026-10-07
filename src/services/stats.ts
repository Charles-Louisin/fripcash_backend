import { Category } from "../models/catalog.js";
import { Order, Wallet } from "../models/commerce.js";
import { Listing } from "../models/listing.js";
import { AuditLog, Dispute } from "../models/ops.js";
import { Review } from "../models/social.js";
import { User } from "../models/user.js";
import { toListing } from "../serializers.js";
import { sid } from "../utils/ids.js";
import { getSettings } from "./notify.js";

const DEST_LABELS: Record<string, string> = {
  SECONDE_MAIN: "Seconde main",
  ARTICLES_NEUFS: "Articles neufs",
  QUARTIER_BOUTIQUES: "Quartier boutiques",
  ENSEIGNES: "Enseignes",
};

const STATUS_LABELS: Record<string, string> = {
  PAID: "Payée",
  SELLER_NOTIFIED: "Vendeur notifié",
  PREPARING: "Préparation",
  READY_FOR_PICKUP: "Prêt à récupérer",
  COURIER_ASSIGNED: "Livreur assigné",
  COLLECTED: "Collectée",
  IN_TRANSIT: "En livraison",
  DELIVERED: "Livrée",
  FUNDS_RELEASED: "Fonds libérés",
  FEEDBACK_PENDING: "Avis",
  DISPUTED: "Litige",
  REFUNDED: "Remboursée",
};

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function eachDay(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

function orderNet(o: any) {
  return (o.items || []).reduce(
    (s: number, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1),
    0
  );
}

function mapAuditType(
  action?: string,
  entityType?: string
): "signup" | "sale" | "dispute" | "article" | "delivery" {
  const a = `${action || ""} ${entityType || ""}`.toLowerCase();
  if (a.includes("dispute")) return "dispute";
  if (a.includes("order") || a.includes("sale") || a.includes("checkout")) return "sale";
  if (a.includes("listing") || a.includes("article") || a.includes("comment")) return "article";
  if (a.includes("courier") || a.includes("delivery") || a.includes("mission")) return "delivery";
  if (a.includes("user") || a.includes("signup") || a.includes("provision")) return "signup";
  return "article";
}

function formatRelativeFr(iso?: Date | string) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "à l'instant";
  if (diffSec < 3600) return `il y a ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `il y a ${Math.floor(diffSec / 3600)} h`;
  return `il y a ${Math.floor(diffSec / 86400)} j`;
}

export async function buildAdminStats(days = 30) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [listings, orders, users, disputes, auditLogs, categories, settings, wallets] =
    await Promise.all([
      Listing.find().sort({ createdAt: -1 }).lean(),
      Order.find().sort({ createdAt: -1 }).lean(),
      User.find().lean(),
      Dispute.find().sort({ createdAt: -1 }).lean(),
      AuditLog.find().sort({ createdAt: -1 }).limit(30).lean(),
      Category.find().lean(),
      getSettings(),
      Wallet.find().lean(),
    ]);

  const userById = new Map(users.map((u) => [String(u._id), u]));
  const categoryNameById = new Map(
    categories.map((c) => [String(c._id), c.nameFr || c.nameEn || c.slug])
  );

  const pendingStatuses = new Set(["DRAFT", "FLAGGED"]);
  const pendingListingsRaw = listings.filter((l) =>
    pendingStatuses.has(String(l.status).toUpperCase())
  );
  const activeListings = listings.filter((l) => String(l.status).toUpperCase() === "ACTIVE");
  const soldListings = listings.filter((l) => {
    const s = String(l.status).toUpperCase();
    return s === "SOLD" || s === "SOLD_OUT";
  });
  const draftListings = listings.filter((l) => String(l.status).toUpperCase() === "DRAFT");

  const pendingVerifications = users.filter((u) => {
    const st = String(u.seller?.verificationStatus || "");
    return st === "pending" || st === "rejected";
  });

  const listingsByCategory = new Map<string, number>();
  const listingsByDestination = new Map<string, number>();
  for (const listing of listings) {
    const catKey = listing.categoryId
      ? categoryNameById.get(String(listing.categoryId)) || "Autre"
      : "Sans catégorie";
    listingsByCategory.set(catKey, (listingsByCategory.get(catKey) || 0) + 1);
    const destKey = DEST_LABELS[listing.destination] || listing.destination || "Autre";
    listingsByDestination.set(destKey, (listingsByDestination.get(destKey) || 0) + 1);
  }

  const catalogValueGnf = activeListings.reduce(
    (sum, l) => sum + (l.priceGnf || 0) * (l.quantity || 1),
    0
  );

  const heldOrders = orders.filter((o) => o.escrowStatus === "held");
  const escrowGmv = heldOrders.reduce((s, o) => s + orderNet(o), 0);

  const nonRefunded = orders.filter((o) => o.status !== "REFUNDED");
  const gmv = nonRefunded.reduce((s, o) => s + (o.amountGnf || 0), 0);
  const totalRevenue = nonRefunded.reduce((s, o) => s + (o.commissionGnf || 0), 0);

  const ordersInRange = orders.filter((o) => o.createdAt && new Date(o.createdAt) >= since);
  const gmvRange = ordersInRange
    .filter((o) => o.status !== "REFUNDED")
    .reduce((s, o) => s + (o.amountGnf || 0), 0);
  const revenueRange = ordersInRange
    .filter((o) => o.status !== "REFUNDED")
    .reduce((s, o) => s + (o.commissionGnf || 0), 0);

  const monthOrders = orders.filter(
    (o) => o.createdAt && new Date(o.createdAt) >= monthStart && o.status !== "REFUNDED"
  );
  const gmvCourier = monthOrders
    .filter((o) => o.fulfillmentMode === "courier")
    .reduce((s, o) => s + (o.amountGnf || 0), 0);
  const gmvPickup = monthOrders
    .filter((o) => o.fulfillmentMode !== "courier")
    .reduce((s, o) => s + (o.amountGnf || 0), 0);

  const activeDeliveryStatuses = new Set([
    "READY_FOR_PICKUP",
    "COURIER_ASSIGNED",
    "COLLECTED",
    "IN_TRANSIT",
  ]);
  const activeDeliveries = orders.filter((o) =>
    activeDeliveryStatuses.has(String(o.status))
  ).length;

  const openDisputesRaw = disputes.filter(
    (d) => d.status === "open" || d.status === "under_review"
  );

  const openDisputes = openDisputesRaw.slice(0, 8).map((d) => {
    const order = orders.find((o) => String(o._id) === String(d.orderId));
    const buyer = order ? userById.get(String(order.buyerId)) : null;
    const seller = order ? userById.get(String(order.sellerId)) : null;
    return {
      id: sid(d._id),
      orderId: sid(d.orderId),
      reason: d.reason,
      status: d.status,
      productTitle: order?.items?.[0]?.title || "Article",
      buyerName: buyer?.name || "Acheteur",
      sellerName: seller?.seller?.shopName || seller?.name || "Vendeur",
      amount: order?.amountGnf || 0,
      openedAt: d.createdAt,
    };
  });

  const keys = eachDay(days);
  const txMap = new Map(keys.map((k) => [k, { date: k, revenus: 0, commissions: 0 }]));
  const insMap = new Map(keys.map((k) => [k, { date: k, acheteurs: 0, vendeurs: 0 }]));

  for (const o of orders) {
    if (!o.createdAt) continue;
    const k = dayKey(new Date(o.createdAt));
    const row = txMap.get(k);
    if (!row || o.status === "REFUNDED") continue;
    row.revenus += o.amountGnf || 0;
    row.commissions += o.commissionGnf || 0;
  }
  for (const u of users) {
    if (!u.createdAt) continue;
    const k = dayKey(new Date(u.createdAt));
    const row = insMap.get(k);
    if (!row) continue;
    if (u.seller?.kind) row.vendeurs += 1;
    else if (u.authAudience !== "ADMIN") row.acheteurs += 1;
  }

  const courierCounts = new Map<string, { name: string; deliveries: number }>();
  for (const o of orders) {
    if (!o.courierId) continue;
    const done = ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status));
    if (!done) continue;
    const at = o.updatedAt || o.createdAt;
    if (at && new Date(at) < monthStart) continue;
    const id = String(o.courierId);
    const courier = userById.get(id);
    const name = o.courierName || courier?.name || "Livreur";
    const prev = courierCounts.get(id) || { name, deliveries: 0 };
    prev.deliveries += 1;
    courierCounts.set(id, prev);
  }

  const ordersByStatusMap = new Map<string, number>();
  for (const o of orders) {
    const label = STATUS_LABELS[o.status] || o.status;
    ordersByStatusMap.set(label, (ordersByStatusMap.get(label) || 0) + 1);
  }

  const ordersByZoneMap = new Map<string, number>();
  for (const o of ordersInRange) {
    const zone = (o.address as any)?.city || "Non précisé";
    ordersByZoneMap.set(zone, (ordersByZoneMap.get(zone) || 0) + 1);
  }

  const gmvByListing = new Map<string, { id: string; title: string; gmv: number }>();
  for (const o of nonRefunded) {
    for (const item of o.items || []) {
      const id = item.listingId ? String(item.listingId) : item.title || "x";
      const prev = gmvByListing.get(id) || {
        id,
        title: item.title || "Article",
        gmv: 0,
      };
      prev.gmv += (item.priceGnf || 0) * (item.quantity || 1);
      gmvByListing.set(id, prev);
    }
  }
  const listingById = new Map(listings.map((l) => [String(l._id), l]));
  const topListingsByGmv = [...gmvByListing.values()]
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, 8)
    .map((row) => {
      const listing = listingById.get(row.id);
      return {
        ...row,
        media: listing?.media || [],
      };
    });

  const pendingListings = pendingListingsRaw.slice(0, 10).map((l) => {
    const seller = userById.get(String(l.sellerId));
    return toListing(l, seller);
  });

  const reservedWallets = wallets.reduce((s, w) => s + (w.reservedGnf || 0), 0);

  return {
    totalListings: listings.length,
    activeListings: activeListings.length,
    soldListings: soldListings.length,
    draftListings: draftListings.length,
    pendingListings,
    pendingListingCount: pendingListingsRaw.length,
    pendingShopCount: pendingVerifications.filter(
      (u) => u.seller?.verificationStatus === "pending"
    ).length,
    catalogValueGnf,
    commissionRatePercent: Math.round((settings.commissionRateStandard || 0) * 10000) / 100,
    commissionRateProximitePercent:
      Math.round((settings.commissionRateProximite || 0) * 10000) / 100,
    platformSettings: {
      id: "default",
      commissionRateStandard: settings.commissionRateStandard,
      commissionRateProximite: settings.commissionRateProximite,
      disputeWindowHours: settings.disputeWindowHours,
      minWithdrawalGnf: settings.minWithdrawalGnf,
      maxListingPhotos: settings.maxListingPhotos,
      maintenanceMode: settings.maintenanceMode,
    },
    categoryChart: [...listingsByCategory.entries()]
      .map(([category, volume]) => ({ category, volume }))
      .sort((a, b) => b.volume - a.volume),
    destinationChart: [...listingsByDestination.entries()]
      .map(([category, volume]) => ({ category, volume }))
      .sort((a, b) => b.volume - a.volume),
    activity: auditLogs.slice(0, 12).map((log: any) => ({
      id: sid(log._id),
      type: mapAuditType(log.action, log.entityType || log.target),
      message: `${log.action || "action"}${log.target ? ` · ${log.target}` : ""}`,
      time: formatRelativeFr(log.createdAt),
    })),
    openDisputes,
    openDisputeCount: openDisputesRaw.length,
    escrowGmv,
    escrowHoldCount: heldOrders.length,
    walletReservedGnf: reservedWallets,
    totalUsers: users.filter((u) => !u.banned).length,
    totalRevenue,
    gmv,
    gmvRange,
    revenueRange,
    activeDeliveries,
    gmvCourier,
    gmvPickup,
    courierPerf: [...courierCounts.values()].sort((a, b) => b.deliveries - a.deliveries),
    ordersByStatus: [...ordersByStatusMap.entries()].map(([status, count]) => ({
      status,
      count,
    })),
    ordersByZone: [...ordersByZoneMap.entries()].map(([zone, commandes]) => ({
      zone,
      commandes,
    })),
    topListingsByGmv,
    chart: {
      transactions: [...txMap.values()],
      inscriptions: [...insMap.values()],
    },
    days,
  };
}

export async function buildPublicStats() {
  const [users, activeListings, soldListings, orders, rating] = await Promise.all([
    User.countDocuments({ banned: { $ne: true }, authAudience: { $ne: "ADMIN" } }),
    Listing.countDocuments({ status: "ACTIVE", hidden: { $ne: true } }),
    Listing.countDocuments({ status: { $in: ["SOLD", "SOLD_OUT"] } }),
    Order.countDocuments({ status: { $nin: ["REFUNDED"] } }),
    Review.aggregate<{ avg: number; n: number }>([
      { $match: { hidden: { $ne: true } } },
      { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } },
    ]),
  ]);
  const avgRating = rating[0]?.avg ? Math.round(rating[0].avg * 10) / 10 : 0;
  return {
    totalUsers: users,
    totalSold: soldListings,
    avgRating,
    totalArticles: activeListings,
    users,
    articles: activeListings,
    orders,
    rating: avgRating,
    reviewCount: rating[0]?.n || 0,
  };
}

export async function buildSalesChart(sellerId: string, days = 30) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const orders = await Order.find({
    sellerId,
    createdAt: { $gte: since },
    status: { $ne: "REFUNDED" },
  }).lean();
  const keys = eachDay(days);
  const map = new Map(keys.map((k) => [k, { date: k, ventes: 0, revenus: 0 }]));
  for (const o of orders) {
    const k = dayKey(new Date(o.createdAt));
    const row = map.get(k);
    if (!row) continue;
    row.ventes += 1;
    row.revenus += o.amountGnf || 0;
  }
  return [...map.values()];
}
