/** Vues financières filtrées par rôle : aucun vendeur ne voit les montants d'un autre vendeur. */
import { Order } from "../../models/commerce.js";
import { Delivery, ParentOrder, Payout } from "../../models/finance.js";
import type { AuthedRequest } from "../../middleware/auth.js";
import { forbidden, notFound } from "../../utils/http-error.js";
import { sid } from "../../utils/ids.js";

function payoutView(p: any) {
  return p ? { status: p.status, amount: p.amount, completedAt: p.completedAt || null, failureCode: p.failureCode || "" } : null;
}

async function parentView(parent: any) {
  const orders = await Order.find({ _id: { $in: parent.sellerOrderIds } }, "orderNumber amountGnf shippingCostGnf status items.title").lean();
  return {
    orderNumber: parent.orderNumber,
    status: parent.status,
    paymentStatus: parent.payment?.status,
    currency: parent.currency,
    summary: parent.summary,
    sellerOrders: orders.map((o) => ({
      id: sid(o._id),
      orderNumber: o.orderNumber,
      amount: o.amountGnf,
      deliveryAmount: o.shippingCostGnf || 0,
      status: o.status,
      items: (o.items || []).map((i: any) => i.title),
    })),
  };
}

export async function sellerOrderFinancialView(id: string, req: AuthedRequest) {
  const uid = req.userId!;
  const isAdmin = req.audience === "ADMIN";

  const parent = await ParentOrder.findById(id).lean().catch(() => null);
  if (parent) {
    if (!isAdmin && sid(parent.buyerId) !== uid) throw forbidden();
    return { ...(await parentView(parent)), ...(isAdmin ? { financialSummary: parent.financialSummary } : {}) };
  }

  const order = await Order.findById(id).lean().catch(() => null);
  if (!order) throw notFound();
  if (!order.parentOrderId) return { legacy: true, escrowStatus: order.escrowStatus };

  if (sid(order.sellerId) === uid || isAdmin) {
    const payout = order.payoutId ? await Payout.findById(order.payoutId).lean() : null;
    const d = order.financialDetails || ({} as any);
    return {
      sellerOrder: {
        id: sid(order._id),
        orderNumber: order.orderNumber,
        items: (order.items || []).map((i: any) => ({ title: i.title, quantity: i.quantity, unitPrice: i.priceGnf })),
        grossAmount: order.amountGnf,
        discount: d.discount ?? 0,
        commissionRate: d.platformCommissionRate ?? null,
        commission: d.platformCommissionAmount ?? order.commissionGnf,
        netAmount: d.sellerNetAmount ?? null,
        deliveryStatus: order.status,
        payoutStatus: order.payoutStatus,
        payout: payoutView(payout),
      },
    };
  }
  if (sid(order.courierId) === uid && order.deliveryId) {
    const delivery = await Delivery.findById(order.deliveryId).lean();
    const payout = delivery?.courierPayoutId ? await Payout.findById(delivery.courierPayoutId).lean() : null;
    return { delivery: { id: sid(order.deliveryId), fee: delivery?.deliveryFee ?? 0, status: delivery?.status, payout: payoutView(payout) } };
  }
  if (sid(order.buyerId) === uid) {
    const p = await ParentOrder.findById(order.parentOrderId).lean();
    if (p) return parentView(p);
  }
  throw forbidden();
}
