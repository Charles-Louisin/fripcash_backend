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
import {
  getSettings,
  notify,
  notifyAdmins,
  notifyCouriersForOrder,
  notifyOrderParties,
} from "../services/notify.js";
import { hydrateCourierOrder, hydrateOrder } from "../services/orders-hydrate.js";
import { buildSalesChart } from "../services/stats.js";
import { legacyOrderError } from "../services/payments.js";
import { User } from "../models/user.js";
import {
  confirmDelivery,
  confirmSellerOrderReceipt,
  holdForDispute,
  isFinancialOrder,
  refundSellerOrder,
} from "../services/finance/delivery-service.js";
import { sellerOrderFinancialView } from "../services/finance/views.js";
import type { Request, Response } from "express";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

/** Commande du système financier : réception = éligibilité du vendeur (le worker paie ensuite). */
async function financialReceipt(row: any, req: AuthedRequest, role: "buyer" | "admin" | "seller_code") {
  await confirmSellerOrderReceipt(row._id, { userId: req.userId!, role });
}

/** Commande antérieure à Chap Chap Pay : la réception est notée, le règlement est fait à la main. */
async function flagLegacySettlement(row: any) {
  row.timeline.push({ status: row.status, at: new Date(), note: "Règlement vendeur à effectuer manuellement (ancienne commande)" });
  await row.save();
  await notifyAdmins(
    "order",
    "Ancienne commande à régler",
    `${row.items?.[0]?.title || "Commande"} : réception confirmée, reversement vendeur à faire manuellement.`,
    { orderId: sid(row._id) }
  );
}

async function financialCourierConfirmation(row: any, req: AuthedRequest) {
  if (!row.deliveryId || !row.courierId) return;
  await confirmDelivery(row.deliveryId, {
    method: req.audience === "ADMIN" ? "admin_validation" : "buyer_confirmation",
    by: req.userId!,
  });
}

const TRANSITIONS: Record<string, string[]> = {
  ORDERED: ["PAID", "REFUNDED", "DISPUTED"],
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
    if ((req as AuthedRequest).audience === "COURIER") {
      res.json(await hydrateCourierOrder(row, uid));
      return;
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

    if (isFinancialOrder(row) && next === "FUNDS_RELEASED") {
      // Le statut FUNDS_RELEASED est posé par le worker quand le transfert est vérifié réussi.
      await financialReceipt(row, req as AuthedRequest, (req as AuthedRequest).audience === "ADMIN" ? "admin" : "buyer");
    } else if (isFinancialOrder(row) && next === "REFUNDED" && row.escrowStatus === "held") {
      await refundSellerOrder(row._id, "Remboursement commande FripCash", (req as AuthedRequest).userId!);
    } else if (next === "FUNDS_RELEASED" && (row.escrowStatus === "held" || row.escrowStatus === "payout_pending")) {
      throw legacyOrderError();
    } else if (
      next === "REFUNDED" &&
      (row.escrowStatus === "held" || row.escrowStatus === "refund_pending")
    ) {
      throw legacyOrderError();
    } else {
      row.status = next;
      row.timeline.push({ status: next, at: new Date(), note });
      await row.save();
      await notifyOrderParties(row, next, note);
    }
    const fresh = await Order.findById(row._id);
    if (!fresh) throw notFound();
    res.json(await hydrateOrder(fresh));
  })
);

/** Partagé par POST /orders/:id/confirm-reception et POST /seller-orders/:id/confirm-receipt. */
export const confirmReceptionHandler = ah(async (req: Request, res: Response) => {
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
    const firstConfirmation = !row.buyerConfirmedAt;
    if (firstConfirmation) {
      row.buyerConfirmedAt = new Date();
      row.timeline.push({
        status: "BUYER_CONFIRMED",
        at: new Date(),
        note: "Le client a appuyé sur « Colis reçu »",
      });
    }
    if (row.status !== "DELIVERED") {
      row.status = "DELIVERED";
      row.timeline.push({ status: "DELIVERED", at: new Date(), note: "Réception confirmée" });
    }
    let courier: any = null;
    if (firstConfirmation && row.courierId) {
      courier = await User.findById(row.courierId);
    }
    await row.save();
    if (firstConfirmation && isFinancialOrder(row)) {
      await financialCourierConfirmation(row, req as AuthedRequest);
    }
    if (firstConfirmation) {
      await notifyOrderParties(
        { _id: row._id, buyerId: row.buyerId, sellerId: row.sellerId },
        "DELIVERED",
        "L'acheteur a confirmé la réception."
      );
      if (courier) {
        await notify(
          sid(courier._id),
          "order",
          "Réception confirmée par le client",
          `${(row.address as any)?.name || "Le client"} a appuyé sur « Colis reçu ». Tu peux laisser le colis : la course est terminée.`,
          { orderId: sid(row._id), status: "DELIVERED" }
        );
      }
    }
    if (isFinancialOrder(row)) {
      await financialReceipt(row, req as AuthedRequest, (req as AuthedRequest).audience === "ADMIN" && sid(row.buyerId) !== uid ? "admin" : "buyer");
    } else if (row.escrowStatus === "held" || row.escrowStatus === "payout_pending") {
      await flagLegacySettlement(row);
    }
    const fresh = await Order.findById(row._id);
    if (!fresh) throw notFound();
    res.json(await hydrateOrder(fresh));
});

ordersRouter.post("/:id/confirm-reception", confirmReceptionHandler);

/** Synthèse financière : le vendeur ne voit que SA sous-commande ; l'acheteur, ses totaux. */
ordersRouter.get(
  "/:id/financial-summary",
  ah(async (req, res) => {
    res.json(await sellerOrderFinancialView(String(req.params.id), req as AuthedRequest));
  })
);

ordersRouter.get(
  "/:id/seller-orders",
  ah(async (req, res) => {
    const view = await sellerOrderFinancialView(String(req.params.id), req as AuthedRequest);
    if (!("sellerOrders" in view)) throw forbidden();
    res.json(view.sellerOrders);
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

const PICKUP_HANDOFF_STATUSES = ["PAID", "SELLER_NOTIFIED", "PREPARING", "READY_FOR_PICKUP"];
const PICKUP_MAX_ATTEMPTS = 5;

ordersRouter.post(
  "/:id/pickup-code/verify",
  validate(z.object({ code: z.string().regex(/^\d{6}$/, "Le code doit contenir 6 chiffres") })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (sid(row.sellerId) !== uid && (req as AuthedRequest).audience !== "ADMIN") {
      throw forbidden();
    }
    if (row.fulfillmentMode !== "pickup") {
      throw badRequest("FULFILLMENT", "Cette commande n'est pas en retrait par code");
    }
    if (row.escrowStatus !== "held") {
      throw badRequest("ESCROW", "Le paiement n'est pas (ou plus) bloqué en séquestre");
    }
    if (!PICKUP_HANDOFF_STATUSES.includes(row.status)) {
      throw badRequest("ILLEGAL_TRANSITION", `Retrait impossible depuis ${row.status}`);
    }
    if (row.offerStatus === "pending") {
      throw badRequest("OFFER_PENDING", "Accepte ou refuse l'offre avant de valider le retrait.");
    }
    if (row.pickupCodeAttempts >= PICKUP_MAX_ATTEMPTS) {
      row.pickupCode = null;
      row.pickupCodeAttempts = 0;
      await row.save();
      await notify(
        sid(row.buyerId),
        "order",
        "Code de retrait désactivé",
        "Trop de tentatives incorrectes : le code de retrait est désactivé. Contacte le support FripCash.",
        { orderId: sid(row._id), status: row.status }
      );
      throw badRequest("PICKUP_CODE_LOCKED", "Trop de tentatives : le code est désactivé.");
    }
    if (!row.pickupCode) {
      throw badRequest("PICKUP_CODE_INVALID", "Aucun code actif pour cette commande.");
    }
    if (req.body.code !== row.pickupCode) {
      row.pickupCodeAttempts += 1;
      await row.save();
      if (row.pickupCodeAttempts >= PICKUP_MAX_ATTEMPTS) {
        await notify(
          sid(row.buyerId),
          "order",
          "Code de retrait désactivé",
          "Trop de tentatives incorrectes : le code de retrait est désactivé. Contacte le support FripCash.",
          { orderId: sid(row._id), status: row.status }
        );
      }
      const left = PICKUP_MAX_ATTEMPTS - row.pickupCodeAttempts;
      throw badRequest(
        "PICKUP_CODE_MISMATCH",
        left > 0
          ? `Code incorrect. ${left} tentative${left > 1 ? "s" : ""} avant désactivation.`
          : "Code incorrect : le code est maintenant désactivé."
      );
    }

    row.pickupCode = null;
    row.pickupCodeAttempts = 0;
    if (!row.buyerConfirmedAt) {
      row.buyerConfirmedAt = new Date();
      row.timeline.push({
        status: "BUYER_CONFIRMED",
        at: new Date(),
        note: "Retrait validé par le code vendeur",
      });
    }
    row.status = "DELIVERED";
    row.timeline.push({
      status: "DELIVERED",
      at: new Date(),
      note: "Colis remis — retrait validé par code",
    });
    await row.save();
    await notifyOrderParties(row, "DELIVERED", "Retrait validé par code — colis remis à l'acheteur");
    if (isFinancialOrder(row)) {
      // Le code à 6 chiffres détenu par l'acheteur prouve la remise : équivalent d'un OTP.
      await financialReceipt(row, req as AuthedRequest, "seller_code");
    } else if (row.escrowStatus === "held" || row.escrowStatus === "payout_pending") {
      await flagLegacySettlement(row);
    }
    const fresh = await Order.findById(row._id);
    if (!fresh) throw notFound();
    res.json(await hydrateOrder(fresh));
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
    const ongoing = await Dispute.findOne({
      orderId: row._id,
      status: { $in: ["open", "under_review", "closed"] },
    });
    if (ongoing) {
      res.json({ id: sid(ongoing._id), status: ongoing.status, reason: ongoing.reason });
      return;
    }
    if (["FUNDS_RELEASED", "FEEDBACK_PENDING", "REFUNDED"].includes(row.status)) {
      throw badRequest("DISPUTE_CLOSED", "Le paiement est déjà clôturé : un litige n'est plus possible.");
    }
    // Réception confirmée (« Colis reçu » ou code de retrait) = acceptation définitive du colis :
    // le vendeur est payé à cet instant, aucun litige n'est plus possible sur cette commande.
    if (row.buyerConfirmedAt) {
      throw badRequest(
        "DISPUTE_AFTER_RECEIPT",
        "La réception a été confirmée : un litige n'est plus possible pour cette commande."
      );
    }
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
    if (isFinancialOrder(row)) {
      // Bloque uniquement la somme de CE vendeur ; les autres sous-commandes continuent.
      await holdForDispute(row._id, dispute._id, req.body.reason);
    }
    const data = { disputeId: sid(dispute._id), orderId: sid(row._id) };
    await notify(sid(row.buyerId), "dispute", "Litige ouvert", req.body.reason, data);
    await notify(sid(row.sellerId), "dispute", "Litige ouvert", req.body.reason, data);
    await notifyAdmins(
      "dispute",
      "Nouveau litige à traiter",
      `${row.items?.[0]?.title || "Commande"} — ${req.body.reason}`,
      data
    );
    res.json({ id: sid(dispute._id), status: "open", reason: dispute.reason });
  })
);

ordersRouter.post(
  "/:id/reviews",
  validate(z.object({ rating: z.number().min(1).max(5), comment: z.string().optional(), listingId: z.string() })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.buyerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (!["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(row.status)) {
      throw badRequest("REVIEW_TOO_EARLY", "Tu pourras laisser un avis après la livraison.");
    }
    if (!row.items.some((i: any) => sid(i.listingId) === req.body.listingId)) {
      throw badRequest("REVIEW_LISTING", "Cet article ne fait pas partie de la commande.");
    }
    if (await Review.exists({ orderId: row._id, buyerId: row.buyerId })) {
      throw badRequest("ALREADY_REVIEWED", "Tu as déjà laissé un avis pour cette commande.");
    }
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
  requireAudience("CONSUMER", "COURIER"),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.id);
    if (!row) throw notFound();
    if (sid(row.sellerId) !== (req as AuthedRequest).userId) throw forbidden();
    if (row.escrowStatus !== "held" && row.escrowStatus !== "refund_pending") {
      throw badRequest("ESCROW", "Séquestre déjà clôturé");
    }
    if (isFinancialOrder(row)) {
      await refundSellerOrder(row._id, "Remboursement vendeur FripCash", (req as AuthedRequest).userId!);
    } else {
      throw legacyOrderError();
    }
    const fresh = await Order.findById(row._id);
    if (!fresh) throw notFound();
    res.json(await hydrateOrder(fresh));
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
    if (isFinancialOrder(row) && row.escrowStatus === "held") {
      await refundSellerOrder(row._id, "Annulation après refus d'offre", (req as AuthedRequest).userId!);
    } else if (row.escrowStatus === "held" || row.escrowStatus === "refund_pending") {
      throw legacyOrderError();
    } else {
      row.status = "REFUNDED";
      row.escrowStatus = "refunded";
      row.offerStatus = "refused";
      row.timeline.push({
        status: "REFUNDED",
        at: new Date(),
        note: "Annulation après refus d'offre",
      });
      await row.save();
    }
    await notify(sid(row.sellerId), "order", "Commande annulée", "L'acheteur a annulé après le refus de l'offre.");
    const fresh = await Order.findById(row._id);
    if (!fresh) throw notFound();
    res.json(await hydrateOrder(fresh));
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
      simulated: false,
    });
  })
);
