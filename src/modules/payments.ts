import { Router } from "express";
import { Payment } from "../models/commerce.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ah } from "../utils/async-handler.js";
import { forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { hydrateOrder } from "../services/orders-hydrate.js";
import { Order } from "../models/commerce.js";
import { paymentPublicView, refreshPayment } from "../services/payments.js";
import { verifyChapChapPayment } from "../services/finance/payment-service.js";

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
      const hosted = payment.provider === "chapchappay";
      try {
        payment = await refreshPayment(merchantTransactionId);
      } catch (err) {
        // Chap Chap Pay momentanément injoignable : on affiche l'état connu, le worker revérifiera.
        if (!hosted) throw err;
      }
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

/** Vérification explicite auprès du prestataire (bouton « J'ai payé » / admin). */
paymentsRouter.post(
  "/:merchantTransactionId/verify",
  ah(async (req, res) => {
    const payment = await Payment.findOne({ merchantTransactionId: String(req.params.merchantTransactionId || "") });
    if (!payment) throw notFound("Paiement introuvable");
    const uid = (req as AuthedRequest).userId!;
    if (sid(payment.buyerId) !== uid && (req as AuthedRequest).audience !== "ADMIN") throw forbidden();
    const fresh =
      payment.provider === "chapchappay"
        ? await verifyChapChapPayment(payment._id, { force: (req as AuthedRequest).audience === "ADMIN" })
        : await refreshPayment(payment.merchantTransactionId);
    res.json({ payment: paymentPublicView(fresh, { mustRedirect: Boolean(fresh?.paymentUrl) && fresh?.status === "pending" }) });
  })
);
