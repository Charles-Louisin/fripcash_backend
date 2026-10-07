import { Router } from "express";
import { z } from "zod";
import { Order } from "../models/commerce.js";
import { Dispute } from "../models/ops.js";
import { Review } from "../models/social.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { notify, notifyCouriersForOrder, notifyOrderParties } from "../services/notify.js";
import { hydrateOrder } from "../services/orders-hydrate.js";
import { buildSalesChart } from "../services/stats.js";
import { holdEscrow, refundEscrow, releaseEscrow } from "../services/wallet.js";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const TRANSITIONS: Record<string, string[]> = {
  PAID: ["SELLER_NOTIFIED", "PREPARING", "READY_FOR_PICKUP", "DISPUTED", "REFUNDED"],
  SELLER_NOTIFIED: ["PREPARING", "READY_FOR_PICKUP", "DISPUTED", "REFUNDED"],
  PREPARING: ["READY_FOR_PICKUP", "IN_TRANSIT", "DISPUTED", "REFUNDED"],
  READY_FOR_PICKUP: ["COURIER_ASSIGNED", "DELIVERED", "IN_TRANSIT", "DISPUTED"],
  COURIER_ASSIGNED: ["COLLECTED", "IN_TRANSIT", "DISPUTED"],
  COLLECTED: ["IN_TRANSIT", "DISPUTED"],
  IN_TRANSIT: ["DELIVERED", "DISPUTED"],
  DELIVERED: ["FUNDS_RELEASED", "FEEDBACK_PENDING", "DISPUTED"],
  FUNDS_RELEASED: ["FEEDBACK_PENDING"],
  FEEDBACK_PENDING: [],
  DISPUTED: ["REFUNDED", "FUNDS_RELEASED"],
  REFUNDED: [],
};

function orderNet(row: { items: any[] }) {
  return row.items.reduce((s, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1), 0);
}

ordersRouter.get(
  "/purchases",
  ah(async (req, res) => {
    const rows = await Order.find({ buyerId: (req as AuthedRequest).userId }).sort({ createdAt: -1 });
    res.json(await Promise.all(rows.map(hydrateOrder)));
  })
);

ordersRouter.get(
  "/sales",
  ah(async (req, res) => {
    const rows = await Order.find({ sellerId: (req as AuthedRequest).userId }).sort({ createdAt: -1 });
    res.json(await Promise.all(rows.map(hydrateOrder)));
  })
);

ordersRouter.get(
  "/sales-chart",
  ah(async (req, res) => {
    const days = Number(req.query.days || 30);
    res.json(await buildSalesChart((req as AuthedRequest).userId!, days));
  })
);

ordersRouter.get(
  "/:id",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (![sid(row.buyerId), sid(row.sellerId), sid(row.courierId)].includes(uid)) {
      if ((req as AuthedRequest).audience !== "ADMIN") throw forbidden();
    }
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.patch(
  "/:id/status",
  validate(z.object({ status: z.string(), note: z.string().optional() })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    const next = req.body.status;
    const allowed = TRANSITIONS[row.status] || [];
    if (!allowed.includes(next) && (req as AuthedRequest).audience !== "ADMIN") {
      throw badRequest("ILLEGAL_TRANSITION", `Transition ${row.status} → ${next} interdite`);
    }
    if (next === "FUNDS_RELEASED" && sid(row.buyerId) !== uid && (req as AuthedRequest).audience !== "ADMIN") {
      throw forbidden();
    }
    if (next === "REFUNDED" && sid(row.sellerId) !== uid && (req as AuthedRequest).audience !== "ADMIN") {
      throw forbidden();
    }
    if (
      ["PREPARING", "READY_FOR_PICKUP"].includes(next) &&
      sid(row.sellerId) !== uid &&
      (req as AuthedRequest).audience !== "ADMIN"
    ) {
      throw forbidden();
    }
    if (
      ["PREPARING", "READY_FOR_PICKUP"].includes(next) &&
      row.offerStatus === "pending"
    ) {
      throw badRequest(
        "OFFER_PENDING",
        "Accepte ou refuse l'offre avant de préparer la commande."
      );
    }
    if (next === "IN_TRANSIT" && (req as AuthedRequest).audience !== "ADMIN") {
      const isSeller = sid(row.sellerId) === uid;
      const isCourier = sid(row.courierId) === uid;
      if (row.fulfillmentMode === "courier") {
        if (!row.courierId) throw forbidden();
        if (!isSeller && !isCourier) throw forbidden();
      } else if (!isSeller && !isCourier) {
        throw forbidden();
      }
    }

    let note = req.body.note as string | undefined;
    if (next === "PREPARING" && row.fulfillmentMode === "courier") {
      const notified = await notifyCouriersForOrder(row);
      row.notifiedCourierIds = notified.ids as any;
      note =
        notified.names.length > 0
          ? `Livreur(s) notifié(s) : ${notified.names.join(", ")}`
          : "Aucun livreur disponible dans cette zone";
    }

    row.status = next;
    row.timeline.push({ status: next, at: new Date(), note });

    const net = orderNet(row);

    if (next === "FUNDS_RELEASED" && row.escrowStatus === "held") {
      await releaseEscrow(sid(row.sellerId), net, sid(row._id));
      row.escrowStatus = "released";
    }
    if (next === "REFUNDED" && row.escrowStatus === "held") {
      await refundEscrow(sid(row.sellerId), sid(row.buyerId), net, sid(row._id));
      row.escrowStatus = "refunded";
    }
    if (next === "DELIVERED" && row.fulfillmentMode !== "courier") {
      // pickup complete — buyer still confirms for release
    }
    await row.save();
    await notifyOrderParties(row, next, note);
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/confirm-reception",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (sid(row.buyerId) !== uid && (req as AuthedRequest).audience !== "ADMIN") {
      throw forbidden();
    }
    const confirmable = new Set([
      "READY_FOR_PICKUP",
      "COURIER_ASSIGNED",
      "COLLECTED",
      "IN_TRANSIT",
      "DELIVERED",
    ]);
    if (!confirmable.has(row.status) && (req as AuthedRequest).audience !== "ADMIN") {
      throw badRequest("ILLEGAL_TRANSITION", `Réception impossible depuis ${row.status}`);
    }
    if (row.status !== "DELIVERED") {
      row.status = "DELIVERED";
      row.timeline.push({ status: "DELIVERED", at: new Date(), note: "Réception confirmée" });
    }
    if (row.escrowStatus === "held") {
      await releaseEscrow(sid(row.sellerId), orderNet(row), sid(row._id));
      row.escrowStatus = "released";
    }
    row.status = "FUNDS_RELEASED";
    row.timeline.push({ status: "FUNDS_RELEASED", at: new Date(), note: "Séquestre libérée" });
    await row.save();
    await notifyOrderParties(row, "FUNDS_RELEASED", "L'acheteur a confirmé la réception");
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/request-courier",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.fulfillmentMode !== "courier") {
      throw badRequest("FULFILLMENT", "Cette commande n'est pas en livraison FripCash");
    }
    const from = new Set(["PAID", "SELLER_NOTIFIED", "PREPARING"]);
    if (!from.has(row.status)) {
      throw badRequest("ILLEGAL_TRANSITION", `Mise à disposition impossible depuis ${row.status}`);
    }
    if (!row.notifiedCourierIds?.length) {
      const notified = await notifyCouriersForOrder(row);
      row.notifiedCourierIds = notified.ids as any;
    }
    row.status = "READY_FOR_PICKUP";
    row.timeline.push({
      status: "READY_FOR_PICKUP",
      at: new Date(),
      note: "Colis prêt — mission ouverte aux livreurs",
    });
    await row.save();
    await notifyOrderParties(row, "READY_FOR_PICKUP", "Un livreur FripCash va récupérer la commande");
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/disputes",
  validate(z.object({ reason: z.string().min(3), role: z.enum(["buyer", "seller"]).optional() })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    const role =
      req.body.role ||
      (sid(row.buyerId) === uid ? "buyer" : sid(row.sellerId) === uid ? "seller" : null);
    if (!role) throw forbidden();
    row.status = "DISPUTED";
    row.disputeReason = req.body.reason;
    row.timeline.push({ status: "DISPUTED", at: new Date(), note: req.body.reason });
    await row.save();
    const dispute = await Dispute.create({
      orderId: row._id,
      openedBy: uid,
      openerRole: role,
      reason: req.body.reason,
    });
    await notify(sid(row.buyerId), "dispute", "Litige ouvert", req.body.reason, {
      disputeId: sid(dispute._id),
    });
    await notify(sid(row.sellerId), "dispute", "Litige ouvert", req.body.reason, {
      disputeId: sid(dispute._id),
    });
    res.json({ id: sid(dispute._id), status: "open", reason: dispute.reason });
  })
);

ordersRouter.post(
  "/:id/reviews",
  validate(z.object({ rating: z.number().min(1).max(5), comment: z.string().optional(), listingId: z.string() })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    const review = await Review.create({
      listingId: req.body.listingId,
      orderId: row._id,
      sellerId: row.sellerId,
      buyerId: (req as AuthedRequest).userId,
      rating: req.body.rating,
      comment: req.body.comment || "",
    });
    if (row.status === "DELIVERED" || row.status === "FUNDS_RELEASED") {
      row.status = "FEEDBACK_PENDING";
      await row.save();
    }
    res.json({ id: sid(review._id), rating: review.rating });
  })
);

ordersRouter.post(
  "/:id/seller-refund",
  requireAudience("CONSUMER"),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.escrowStatus !== "held") throw badRequest("ESCROW", "Séquestre déjà clôturé");
    const net = orderNet(row);
    const amount = req.body.amount === "full" || !req.body.amount ? net : Number(req.body.amount);
    await refundEscrow(sid(row.sellerId), sid(row.buyerId), amount, sid(row._id));
    row.status = "REFUNDED";
    row.escrowStatus = "refunded";
    row.timeline.push({ status: "REFUNDED", at: new Date(), note: "Remboursement vendeur" });
    await row.save();
    await notifyOrderParties(row, "REFUNDED", "Remboursement vendeur");
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/offer/accept",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.offerStatus !== "pending") {
      throw badRequest("NO_OFFER", "Aucune offre en attente");
    }
    row.offerStatus = "accepted";
    row.timeline.push({
      status: "OFFER_ACCEPTED",
      at: new Date(),
      note: "Offre acceptée par le vendeur",
    });
    await row.save();
    await notify(sid(row.buyerId), "order", "Offre acceptée", "Le vendeur a accepté ton offre.");
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/offer/refuse",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.offerStatus !== "pending") {
      throw badRequest("NO_OFFER", "Aucune offre en attente");
    }
    row.offerStatus = "refused";
    row.timeline.push({
      status: "OFFER_REFUSED",
      at: new Date(),
      note: "Offre refusée — l'acheteur peut payer le prix normal ou annuler",
    });
    await row.save();
    await notify(
      sid(row.buyerId),
      "order",
      "Offre refusée",
      "Le vendeur a refusé ton offre. Tu peux payer le prix normal ou annuler."
    );
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/offer/pay-full",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.buyerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.offerStatus !== "refused") {
      throw badRequest("OFFER_NOT_REFUSED", "L'offre n'a pas été refusée");
    }
    const original = row.originalAmountGnf || row.amountGnf;
    const complement = Math.max(0, original - (row.amountGnf || 0));
    const origNet = orderNet(row);
    const scale = row.amountGnf > 0 ? original / row.amountGnf : 1;
    const complementNet = Math.max(0, Math.round(origNet * scale - origNet));
    if (complementNet > 0 && row.escrowStatus === "held") {
      await holdEscrow(sid(row.sellerId), complementNet, sid(row._id));
    }
    row.amountGnf = original;
    row.offerStatus = "accepted";
    row.timeline.push({
      status: "PAID",
      at: new Date(),
      note: complement
        ? `Complément ${complement} GNF — prix normal payé`
        : "Prix normal confirmé",
    });
    await row.save();
    await notify(sid(row.sellerId), "order", "Prix normal payé", "L'acheteur a payé le tarif initial.");
    res.json(await hydrateOrder(row));
  })
);

ordersRouter.post(
  "/:id/offer/cancel",
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.buyerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.offerStatus !== "refused") {
      throw badRequest("OFFER_NOT_REFUSED", "L'offre n'a pas été refusée");
    }
    if (row.escrowStatus === "held") {
      await refundEscrow(sid(row.sellerId), sid(row.buyerId), orderNet(row), sid(row._id));
    }
    row.status = "REFUNDED";
    row.escrowStatus = "refunded";
    row.offerStatus = "refused";
    row.timeline.push({
      status: "REFUNDED",
      at: new Date(),
      note: "Annulation après refus d'offre — séquestre remboursé",
    });
    await row.save();
    await notify(sid(row.sellerId), "order", "Commande annulée", "L'acheteur a annulé après le refus de l'offre.");
    res.json(await hydrateOrder(row));
  })
);

export const invoicesRouter = Router();
invoicesRouter.get(
  "/:id/receipt",
  requireAuth,
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    res.json({
      url: null,
      receiptUrl: null,
      order: await hydrateOrder(row),
      simulated: true,
    });
  })
);
