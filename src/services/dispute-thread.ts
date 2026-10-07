import { Order } from "../models/commerce.js";
import { User } from "../models/user.js";
import { sid } from "../utils/ids.js";

export function buyerDisplayName(user: any) {
  const name = String(user?.name || user?.phone || "").trim();
  return name || "Acheteur";
}

export function sellerDisplayName(user: any) {
  const name = String(
    user?.seller?.shopName || user?.name || user?.phone || ""
  ).trim();
  return name || "Vendeur";
}

export function inferSenderRole(
  m: any,
  order: any
): "admin" | "buyer" | "seller" {
  if (m?.fromAdmin || m?.senderRole === "admin") return "admin";
  if (m?.senderRole === "seller" || m?.senderRole === "buyer") return m.senderRole;
  const senderId = sid(m?.senderId);
  if (order && senderId && senderId === sid(order.buyerId)) return "buyer";
  if (order && senderId && senderId === sid(order.sellerId)) return "seller";
  return "buyer";
}

export function serializeDisputeMessage(
  m: any,
  ctx: { order: any; buyer: any; seller: any }
) {
  const senderRole = inferSenderRole(m, ctx.order);
  const senderName =
    senderRole === "admin"
      ? "Admin"
      : senderRole === "seller"
        ? sellerDisplayName(ctx.seller)
        : buyerDisplayName(ctx.buyer);

  return {
    id: m?._id ? sid(m._id) : undefined,
    senderId: m?.senderId ? sid(m.senderId) : null,
    senderRole,
    senderName,
    body: m?.body || "",
    fromAdmin: senderRole === "admin",
    kind: m?.kind || "text",
    requestedKinds: m?.requestedKinds || [],
    attachments: (m?.attachments || []).map((a: any) => ({
      url: a.url,
      storageKey: a.storageKey,
      mimeType: a.mimeType,
      name: a.name,
    })),
    createdAt: m?.createdAt,
  };
}

export async function loadDisputeParties(d: any) {
  const order = d?.orderId?.items
    ? d.orderId
    : await Order.findById(d.orderId).lean();
  const [buyer, seller] = await Promise.all([
    order?.buyerId ? User.findById(order.buyerId).lean() : null,
    order?.sellerId ? User.findById(order.sellerId).lean() : null,
  ]);
  return { order, buyer, seller };
}
