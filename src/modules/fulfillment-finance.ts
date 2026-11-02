/** Endpoints de confirmation (spécification §13) : sous-commandes et livraisons. */
import { Router } from "express";
import { Order } from "../models/commerce.js";
import { Delivery } from "../models/finance.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ah } from "../utils/async-handler.js";
import { forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { confirmDelivery } from "../services/finance/delivery-service.js";
import { confirmReceptionHandler } from "./orders.js";

export const sellerOrdersRouter = Router();
sellerOrdersRouter.use(requireAuth);

/** Alias de POST /orders/:id/confirm-reception (même contrôles, même effet). */
sellerOrdersRouter.post("/:id/confirm-receipt", confirmReceptionHandler);

export const deliveriesRouter = Router();
deliveriesRouter.use(requireAuth);

async function loadDelivery(req: AuthedRequest) {
  const delivery = await Delivery.findById(req.params.id).lean();
  if (!delivery) throw notFound();
  const orders = await Order.find({ _id: { $in: delivery.sellerOrderIds } }, "buyerId sellerId courierId status").lean();
  const uid = req.userId!;
  const isBuyer = orders.some((o) => sid(o.buyerId) === uid);
  const isParty = isBuyer || orders.some((o) => sid(o.sellerId) === uid) || sid(delivery.courierId) === uid;
  if (!isParty && req.audience !== "ADMIN") throw forbidden();
  return { delivery, orders, isBuyer };
}

deliveriesRouter.get(
  "/:id",
  ah(async (req, res) => {
    const { delivery } = await loadDelivery(req as AuthedRequest);
    res.json({
      id: sid(delivery._id),
      parentOrderId: sid(delivery.parentOrderId),
      sellerOrderIds: delivery.sellerOrderIds.map((x) => sid(x)),
      courierId: delivery.courierId ? sid(delivery.courierId) : null,
      deliveryFee: delivery.deliveryFee,
      status: delivery.status,
      confirmation: delivery.confirmation,
    });
  })
);

/** Seul le client (ou l'admin) confirme : le livreur ne peut pas valider sa propre prestation. */
deliveriesRouter.post(
  "/:id/confirm-delivery",
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { isBuyer } = await loadDelivery(r);
    if (!isBuyer && r.audience !== "ADMIN") throw forbidden("BUYER_ONLY", "Seul le client confirme la livraison.");
    const out = await confirmDelivery(req.params.id, {
      method: isBuyer ? "buyer_confirmation" : "admin_validation",
      by: r.userId!,
    });
    res.json({ id: sid(out.delivery._id), status: out.delivery.status });
  })
);
