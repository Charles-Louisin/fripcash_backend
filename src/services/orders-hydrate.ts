import { User } from "../models/user.js";
import { Listing } from "../models/listing.js";
import { Review } from "../models/social.js";
import { Zone } from "../models/catalog.js";
import { toOrder } from "../serializers.js";
import { sid } from "../utils/ids.js";
import { mediaUrlsFromListing, publicMediaUrl } from "../utils/public-url.js";

async function loadParties(order: any) {
  const listingIds = (order.items || [])
    .map((item: { listingId?: unknown }) => item.listingId)
    .filter(Boolean);
  const [buyer, seller, courier, listings, reviewed] = await Promise.all([
    User.findById(order.buyerId).lean(),
    User.findById(order.sellerId).lean(),
    order.courierId ? User.findById(order.courierId).lean() : null,
    listingIds.length
      ? Listing.find({ _id: { $in: listingIds } }).select("title media").lean()
      : [],
    Review.exists({ orderId: order._id, buyerId: order.buyerId }),
  ]);
  return { buyer, seller, courier, listings, reviewed };
}

async function build(order: any) {
  const parties = await loadParties(order);
  const { buyer, seller, courier, listings, reviewed } = parties;
  const byId = new Map(listings.map((row) => [String(row._id), row]));
  const images: string[] = [];
  for (const item of order.items || []) {
    const snapped = publicMediaUrl(item.imageUrl);
    if (snapped) {
      images.push(snapped);
      continue;
    }
    images.push(...mediaUrlsFromListing(byId.get(String(item.listingId))));
  }
  if (!images.length && listings[0]) {
    images.push(...mediaUrlsFromListing(listings[0]));
  }
  const uniqueImages = [...new Set(images)];
  const notifiedIds = (order.notifiedCourierIds || []).map((id: unknown) => sid(id));
  const notifiedUsers = notifiedIds.length
    ? await User.find({ _id: { $in: notifiedIds } }).lean()
    : [];
  const dto = toOrder(order, {
    images: uniqueImages,
    reviewed: !!reviewed,
    buyer: {
      id: sid(order.buyerId),
      pseudo: buyer?.name || "acheteur",
      avatarUrl: publicMediaUrl(buyer?.avatarUrl) || "",
    },
    seller: {
      id: sid(order.sellerId),
      pseudo: seller?.seller?.shopName || seller?.name || "vendeur",
      avatarUrl: publicMediaUrl(seller?.avatarUrl) || "",
      sellerKind: seller?.seller?.kind || null,
      shopKind: seller?.seller?.shopKind || null,
    },
    courier: courier
      ? {
          id: sid(courier._id),
          pseudo: courier.name || "livreur",
          avatarUrl: publicMediaUrl(courier.courier?.portraitUrl || courier.avatarUrl) || "",
        }
      : null,
    courierName: courier?.name || order.courierName || null,
    notifiedCourierNames: notifiedUsers.map((u) => u.name || "Livreur"),
  });
  return { dto, parties };
}

export async function hydrateOrder(order: any) {
  return (await build(order)).dto;
}

/**
 * Vue livreur : coordonnées complètes une fois la course acceptée,
 * uniquement les noms de lieux tant qu'elle ne l'est pas.
 */
export async function hydrateCourierOrder(order: any, courierId: string) {
  const { dto, parties } = await build(order);
  const { seller, buyer } = parties;
  const accepted = !!order.courierId && sid(order.courierId) === courierId;
  const collected = accepted && order.status !== "COURIER_ASSIGNED";
  const address = (order.address || {}) as Record<string, unknown>;
  const zoneIds = [order.pickupZoneId, address.zoneId].filter(Boolean).map(String);
  const zones = zoneIds.length ? await Zone.find({ _id: { $in: zoneIds } }).select("nameFr").lean() : [];
  const zoneName = (id: unknown) => zones.find((z) => String(z._id) === String(id))?.nameFr || "";
  const pickupPlace = [seller?.seller?.neighborhood, zoneName(order.pickupZoneId) || seller?.city]
    .filter(Boolean)
    .join(", ");
  const dropPlace = [zoneName(address.zoneId), String(address.city || "")]
    .filter(Boolean)
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(", ");
  return {
    ...dto,
    address: accepted
      ? {
          line: address.line || "",
          city: address.city || "",
          name: address.name || "",
          zoneId: address.zoneId || null,
          ...(collected ? { phone: address.phone || "" } : {}),
        }
      : { city: address.city || "", zoneId: address.zoneId || null },
    pickup: {
      place: pickupPlace || "Boutique du vendeur",
      ...(accepted
        ? {
            address: seller?.seller?.storeAddress || "",
            landmark: seller?.seller?.landmark || "",
            phone: seller?.phone || "",
            openingTime: seller?.seller?.openingTime || "",
            closingTime: seller?.seller?.closingTime || "",
          }
        : {}),
    },
    dropoff: {
      place: dropPlace || "Adresse du client",
      ...(accepted
        ? {
            address: String(address.line || ""),
            ...(collected ? { phone: String(address.phone || "") } : {}),
            name: String(address.name || buyer?.name || ""),
          }
        : {}),
    },
  };
}
