import { Conversation, Message } from "../models/social.js";
import { sid } from "../utils/ids.js";
import { notify } from "./notify.js";

export function courierPublicCard(user: any) {
  const courier = user?.courier || {};
  return {
    kind: "courier" as const,
    name: user?.name || "Livreur",
    phone: user?.phone || "",
    portraitUrl: courier.portraitUrl || user?.avatarUrl || "",
    vehicle: courier.vehicle || "",
    plate: courier.plate || "",
  };
}

export async function announceCourierInChat(order: any, courierUser: any) {
  if (!order?.buyerId || !order?.sellerId || !courierUser?._id) return;
  let conv = await Conversation.findOne({ orderId: order._id });
  if (!conv) {
    conv = await Conversation.create({
      participantIds: [order.buyerId, order.sellerId],
      orderId: order._id,
    });
  }
  const card = courierPublicCard(courierUser);
  const moto = [card.vehicle, card.plate].filter(Boolean).join(" · ");
  const body = [`Livreur assigné : ${card.name}`, moto, card.phone ? `Tél. ${card.phone}` : ""]
    .filter(Boolean)
    .join("\n");
  await Message.create({
    conversationId: conv._id,
    senderId: courierUser._id,
    body,
    kind: "courier",
    meta: card,
  });
  conv.lastMessage = `Livreur : ${card.name}`;
  conv.lastMessageAt = new Date();
  await conv.save();
  const payload = { conversationId: sid(conv._id), orderId: sid(order._id) };
  await notify(sid(order.buyerId), "message", "Livreur en route", `${card.name} prend le colis`, payload);
  await notify(sid(order.sellerId), "message", "Livreur assigné", `${card.name} prend le colis`, payload);
}
