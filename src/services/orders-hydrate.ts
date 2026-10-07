import { User } from "../models/user.js";
import { toOrder } from "../serializers.js";
import { sid } from "../utils/ids.js";

export async function hydrateOrder(order: any) {
  const [buyer, seller, courier] = await Promise.all([
    User.findById(order.buyerId).lean(),
    User.findById(order.sellerId).lean(),
    order.courierId ? User.findById(order.courierId).lean() : null,
  ]);
  const notifiedIds = (order.notifiedCourierIds || []).map((id: unknown) => sid(id));
  const notifiedUsers = notifiedIds.length
    ? await User.find({ _id: { $in: notifiedIds } }).lean()
    : [];
  return toOrder(order, {
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
