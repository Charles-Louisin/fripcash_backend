import { Router } from "express";
import { Payment } from "../models/commerce.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ah } from "../utils/async-handler.js";
import { forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { hydrateOrder } from "../services/orders-hydrate.js";
import { Order } from "../models/commerce.js";
import { paymentPublicView, refreshPayment } from "../services/payments.js";

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

paymentsRouter.get(
  "/:merchantTransactionId",
  ah(async (req, res) => {
    const merchantTransactionId = String(req.params.merchantTransactionId || "");
    let payment = await Payment.findOne({ merchantTransactionId });
    if (!payment) throw notFound("Paiement introuvable");
    const uid = (req as AuthedRequest).userId!;
    const owner = sid(payment.buyerId) === uid || sid(payment.userId) === uid;
    if (!owner && (req as AuthedRequest).audience !== "ADMIN") throw forbidden();
    if (payment.status === "pending") {
      payment = await refreshPayment(merchantTransactionId);
    }
    if (!payment) throw notFound("Paiement introuvable");
    const orders = await Order.find({ _id: { $in: payment.orderIds } });
    res.json({
      payment: paymentPublicView(payment, {
        mustRedirect: Boolean(payment.paymentUrl) && payment.status === "pending",
      }),
      orders: await Promise.all(orders.map(hydrateOrder)),
    });
  })
);
