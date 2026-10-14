import { User } from "../models/user.js";
import { Listing } from "../models/listing.js";
import { toOrder } from "../serializers.js";
import { sid } from "../utils/ids.js";
import { mediaUrlsFromListing, publicMediaUrl } from "../utils/public-url.js";

export async function hydrateOrder(order: any) {
  const listingIds = (order.items || [])
    .map((item: { listingId?: unknown }) => item.listingId)
    .filter(Boolean);
  const [buyer, seller, courier, listings] = await Promise.all([
    User.findById(order.buyerId).lean(),
    User.findById(order.sellerId).lean(),
    order.courierId ? User.findById(order.courierId).lean() : null,
    listingIds.length
      ? Listing.find({ _id: { $in: listingIds } }).select("title media").lean()
      : [],
  ]);
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
  return toOrder(order, {
    images: uniqueImages,
    buyer: {
      id: sid(order.buyerId),
      pseudo: buyer?.name || "acheteur",
    },
    seller: {
      id: sid(order.sellerId),
      pseudo: seller?.seller?.shopName || seller?.name || "vendeur",
    },
    courier: courier
      ? { id: sid(courier._id), pseudo: courier.name || "livreur" }
      : null,
    courierName: courier?.name || order.courierName || null,
    notifiedCourierNames: notifiedUsers.map((u) => u.name || "Livreur"),
  });
}
