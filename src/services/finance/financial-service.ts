/**
 * FinancialService : décomposition d'un panier payé en sommes dues indépendantes.
 * Une allocation par bénéficiaire et par prestation ; montants figés à la commande.
 */
import mongoose from "mongoose";
import { Order, Payment } from "../../models/commerce.js";
import { Dispute } from "../../models/ops.js";
import {
  Delivery,
  FinancialAllocation,
  ParentOrder,
  Payout,
  Refund,
} from "../../models/finance.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { sid } from "../../utils/ids.js";
import {
  auditFinance,
  money,
  newOrderNumber,
  opts,
  recordLedger,
  shortId,
  type Session,
} from "./core.js";
import {
  cancelOpenPayout,
  createPayoutForAllocation,
  createRefundPayout,
  requeueBlockedPayout,
  resizeOpenPayout,
} from "./payout-service.js";

export const PLATFORM_BENEFICIARY = "fripcash";

type SellerOrderLike = {
  _id: unknown;
  sellerId: unknown;
  items: Array<{ priceGnf?: number; netPriceGnf?: number; quantity?: number }>;
  amountGnf: number;
  shippingCostGnf?: number;
  fulfillmentMode?: string;
};

export type SellerBreakdown = {
  sellerOrderId: string;
  sellerId: string;
  productsSubtotal: number;
  discount: number;
  grossAmount: number;
  commission: number;
  commissionRate: number;
  sellerNet: number;
  deliveryAmount: number;
  /** Livraison assurée par un livreur FripCash → allocation livreur séparée. */
  courierDelivery: boolean;
  sellerPayable: number;
};

export type FinancialBreakdown = {
  currency: "GNF";
  totalPaid: number;
  sellers: SellerBreakdown[];
  courierTotal: number;
  platformCommission: number;
  sellersTotal: number;
  totalAllocated: number;
  productsSubtotal: number;
  discounts: number;
};

/** Calcul 100 % serveur, à partir des lignes de commande figées (prix, net vendeur, commission). */
export function calculateFinancialBreakdown(orders: SellerOrderLike[]): FinancialBreakdown {
  const sellers = orders.map((order) => {
    const productsSubtotal = money(
      order.items.reduce((s, i) => s + (i.priceGnf || 0) * (i.quantity || 1), 0)
    );
    const grossAmount = money(order.amountGnf);
    const sellerNet = money(order.items.reduce((s, i) => s + (i.netPriceGnf || 0) * (i.quantity || 1), 0));
    // Commission = brut − net : la somme des allocations égale exactement le montant encaissé.
    const commission = grossAmount - sellerNet;
    if (commission < 0 || sellerNet < 0) {
      throw conflict("FINANCIAL_INCONSISTENCY", "Montant net vendeur supérieur au prix payé.");
    }
    const deliveryAmount = money(order.shippingCostGnf || 0);
    const courierDelivery = order.fulfillmentMode === "courier" && deliveryAmount > 0;
    return {
      sellerOrderId: sid(order._id),
      sellerId: sid(order.sellerId),
      productsSubtotal,
      discount: Math.max(0, productsSubtotal - grossAmount),
      grossAmount,
      commission,
      commissionRate: grossAmount > 0 ? Math.round((commission / grossAmount) * 10_000) / 10_000 : 0,
      sellerNet,
      deliveryAmount,
      courierDelivery,
      // Livraison par le vendeur lui-même : les frais lui reviennent.
      sellerPayable: sellerNet + (courierDelivery ? 0 : deliveryAmount),
    };
  });
  const totalPaid = sellers.reduce((s, x) => s + x.grossAmount + x.deliveryAmount, 0);
  const courierTotal = sellers.reduce((s, x) => s + (x.courierDelivery ? x.deliveryAmount : 0), 0);
  const platformCommission = sellers.reduce((s, x) => s + x.commission, 0);
  const sellersTotal = sellers.reduce((s, x) => s + x.sellerPayable, 0);
  return {
    currency: "GNF",
    totalPaid,
    sellers,
    courierTotal,
    platformCommission,
    sellersTotal,
    totalAllocated: sellersTotal + courierTotal + platformCommission,
    productsSubtotal: sellers.reduce((s, x) => s + x.productsSubtotal, 0),
    discounts: sellers.reduce((s, x) => s + x.discount, 0),
  };
}

export function allocationKeys(orderNumber: string) {
  return {
    seller: (sellerOrderId: unknown) => `${orderNumber}:seller:${sid(sellerOrderId)}`,
    courier: (deliveryId: unknown) => `${orderNumber}:courier:${sid(deliveryId)}`,
    platform: () => `${orderNumber}:platform`,
  };
}

/**
 * Crée ParentOrder, Deliveries, allocations (awaiting_payment) et l'unique Payment client,
 * puis vérifie l'équilibre. À appeler DANS une transaction, sans appel au prestataire.
 */
export async function createFinancialStructure(
  input: {
    orders: any[];
    buyerId: unknown;
    paymentMethod: string;
    payerPhoneE164: string;
    reservedLines: Array<{ listingId: unknown; quantity: number }>;
    appReturnUrl: string;
  },
  session: Session
) {
  const breakdown = calculateFinancialBreakdown(input.orders);
  if (breakdown.totalAllocated !== breakdown.totalPaid) {
    throw conflict("FINANCIAL_BALANCE", "Répartition financière déséquilibrée.");
  }
  const orderNumber = newOrderNumber();
  const keys = allocationKeys(orderNumber);
  const parentId = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();

  const deliveryIds: mongoose.Types.ObjectId[] = [];
  const allocations: any[] = [];

  for (const line of breakdown.sellers) {
    const order = input.orders.find((o) => sid(o._id) === line.sellerOrderId)!;
    let deliveryId: mongoose.Types.ObjectId | null = null;
    if (line.courierDelivery) {
      deliveryId = new mongoose.Types.ObjectId();
      deliveryIds.push(deliveryId);
      await Delivery.create(
        [
          {
            _id: deliveryId,
            deliveryKey: `${orderNumber}:${line.sellerOrderId}`,
            parentOrderId: parentId,
            sellerOrderIds: [order._id],
            courierId: order.courierId || null,
            deliveryFee: line.deliveryAmount,
            status: order.courierId ? "assigned" : "awaiting_courier",
            history: [{ status: "awaiting_courier", at: new Date(), note: "Livraison créée à la commande" }],
          },
        ],
        opts(session)
      );
      allocations.push({
        allocationKey: keys.courier(deliveryId),
        parentOrderId: parentId,
        sellerOrderId: order._id,
        deliveryId,
        beneficiaryType: "courier",
        beneficiaryId: order.courierId || null,
        amount: line.deliveryAmount,
      });
    }
    allocations.push({
      allocationKey: keys.seller(order._id),
      parentOrderId: parentId,
      sellerOrderId: order._id,
      beneficiaryType: "seller",
      beneficiaryId: order.sellerId,
      amount: line.sellerPayable,
      commissionRate: line.commissionRate,
    });
    await Order.updateOne(
      { _id: order._id, parentOrderId: null },
      {
        $set: {
          parentOrderId: parentId,
          orderNumber: `${orderNumber}-${shortId(order._id)}`,
          deliveryId,
          payoutStatus: "not_eligible",
          financialDetails: {
            productsSubtotal: line.productsSubtotal,
            discount: line.discount,
            platformCommissionRate: line.commissionRate,
            platformCommissionAmount: line.commission,
            sellerNetAmount: line.sellerPayable,
            deliveryAmount: line.deliveryAmount,
            currency: "GNF",
          },
        },
      },
      opts(session)
    );
  }
  allocations.push({
    allocationKey: keys.platform(),
    parentOrderId: parentId,
    beneficiaryType: "platform",
    beneficiaryId: PLATFORM_BENEFICIARY,
    amount: breakdown.platformCommission,
  });

  const created = await FinancialAllocation.insertMany(
    allocations.map((a) => ({
      ...a,
      status: "awaiting_payment",
      history: [{ status: "awaiting_payment", at: new Date(), note: "Créée à la commande" }],
    })),
    opts(session)
  );

  await ParentOrder.create(
    [
      {
        _id: parentId,
        orderNumber,
        buyerId: input.buyerId,
        sellerOrderIds: input.orders.map((o) => o._id),
        deliveryIds,
        currency: "GNF",
        summary: {
          productsSubtotal: breakdown.productsSubtotal,
          discounts: breakdown.discounts,
          deliveryTotal: breakdown.sellers.reduce((s, x) => s + x.deliveryAmount, 0),
          serviceFees: 0,
          totalPaid: breakdown.totalPaid,
        },
        payment: { paymentId, provider: "chapchappay", status: "pending" },
        financialSummary: {
          sellersTotal: breakdown.sellersTotal,
          courierTotal: breakdown.courierTotal,
          platformCommission: breakdown.platformCommission,
          providerFees: 0,
          totalAllocated: breakdown.totalAllocated,
        },
        status: "pending_payment",
      },
    ],
    opts(session)
  );

  const [payment] = await Payment.create(
    [
      {
        _id: paymentId,
        // order_id envoyé à Chap Chap Pay : [A-Za-z0-9-_], 4 à 64 caractères.
        merchantTransactionId: orderNumber,
        kind: "payment",
        status: "pending",
        provider: "chapchappay",
        paymentMethod: input.paymentMethod,
        amountGnf: breakdown.totalPaid,
        currency: "GNF",
        phoneE164: input.payerPhoneE164,
        buyerId: input.buyerId,
        parentOrderId: parentId,
        orderIds: input.orders.map((o) => o._id),
        reservedLines: input.reservedLines,
        appReturnUrl: input.appReturnUrl,
      },
    ],
    opts(session)
  );
  await Order.updateMany(
    { _id: { $in: input.orders.map((o) => o._id) } },
    { $set: { paymentMerchantId: orderNumber } },
    opts(session)
  );

  for (const a of created) {
    await recordLedger(
      {
        entryKey: `allocation_created:${a.allocationKey}`,
        type: "allocation_created",
        amount: a.amount,
        direction: "internal",
        parentOrderId: parentId,
        sellerOrderId: a.sellerOrderId,
        allocationId: a._id,
        beneficiaryType: a.beneficiaryType,
        beneficiaryId: a.beneficiaryId,
        reference: a.allocationKey,
      },
      session
    );
  }
  await validateFinancialBalance(parentId, session);
  return { parentOrderId: parentId, orderNumber, payment: payment!, breakdown };
}

/** Somme des allocations = montant du paiement client = total du ParentOrder. */
export async function validateFinancialBalance(parentOrderId: unknown, session: Session) {
  const [parent, payment, allocations] = await Promise.all([
    ParentOrder.findById(parentOrderId, null, opts(session)).lean(),
    Payment.findOne({ parentOrderId, kind: "payment" }, null, opts(session)).lean(),
    FinancialAllocation.find({ parentOrderId }, null, opts(session)).lean(),
  ]);
  if (!parent || !payment) throw notFound("Commande financière introuvable");
  const allocated = allocations.reduce((s, a) => s + a.amount, 0);
  if (allocated !== payment.amountGnf || allocated !== parent.summary!.totalPaid) {
    throw conflict(
      "FINANCIAL_BALANCE",
      `Déséquilibre : alloué ${allocated} GNF, encaissé ${payment.amountGnf} GNF.`
    );
  }
  return { allocated, paid: payment.amountGnf };
}

/** Après encaissement confirmé : toutes les allocations du ParentOrder deviennent `funded`. */
export async function fundAllocations(parentOrderId: unknown, session: Session) {
  const rows = await FinancialAllocation.find({ parentOrderId, status: "awaiting_payment" }, null, opts(session));
  for (const a of rows) {
    a.status = "funded";
    a.history.push({ status: "funded", at: new Date(), note: "Paiement client confirmé" });
    await a.save(opts(session));
  }
}

async function openDisputeFor(sellerOrderId: unknown, session: Session) {
  return Dispute.findOne(
    { orderId: sellerOrderId, status: { $in: ["open", "under_review", "closed"] } },
    null,
    opts(session)
  ).lean();
}

/**
 * Rend éligible UNE allocation (vendeur ou livreur) et crée son Payout unique.
 * Ne touche à aucune autre allocation du ParentOrder.
 */
export async function markAllocationEligible(allocationId: unknown, note: string, session: Session) {
  const allocation = await FinancialAllocation.findById(allocationId, null, opts(session));
  if (!allocation) throw notFound("Allocation introuvable");
  if (allocation.beneficiaryType === "platform") return { allocation, payout: null };
  if (allocation.status !== "funded") {
    // Déjà éligible, en cours, payée ou remboursée : rien à refaire.
    const payout = allocation.payoutId ? await Payout.findById(allocation.payoutId, null, opts(session)) : null;
    return { allocation, payout };
  }
  if (allocation.hold?.active) {
    return { allocation, payout: null, held: true };
  }
  if (!allocation.beneficiaryId) {
    throw badRequest("NO_BENEFICIARY", "Aucun livreur affecté à cette livraison.");
  }
  allocation.status = "eligible";
  allocation.history.push({ status: "eligible", at: new Date(), note });
  await allocation.save(opts(session));
  await recordLedger(
    {
      entryKey: `allocation_eligible:${allocation.allocationKey}`,
      type: "allocation_eligible",
      amount: allocation.amount - (allocation.refundedAmount || 0),
      direction: "internal",
      parentOrderId: allocation.parentOrderId,
      sellerOrderId: allocation.sellerOrderId,
      allocationId: allocation._id,
      beneficiaryType: allocation.beneficiaryType,
      beneficiaryId: allocation.beneficiaryId,
      note,
    },
    session
  );
  const payout = await createPayoutForAllocation(allocation, session);
  return { allocation, payout };
}

export async function sellerAllocationFor(sellerOrderId: unknown, session: Session) {
  return FinancialAllocation.findOne({ sellerOrderId, beneficiaryType: "seller" }, null, opts(session));
}

export async function courierAllocationFor(deliveryId: unknown, session: Session) {
  return FinancialAllocation.findOne({ deliveryId, beneficiaryType: "courier" }, null, opts(session));
}

// ─── Litiges : blocage ciblé ─────────────────────────────────────────────────

/** Bloque uniquement l'allocation du vendeur concerné, jamais celles des autres vendeurs. */
export async function holdSellerOrderFunds(sellerOrderId: unknown, disputeId: unknown, reason: string, session: Session) {
  const allocation = await sellerAllocationFor(sellerOrderId, session);
  if (!allocation) return null;
  if (!allocation.hold?.active) {
    allocation.hold = { active: true, reason, disputeId: disputeId as any, at: new Date() };
    allocation.history.push({ status: allocation.status, at: new Date(), note: `Bloquée : ${reason}` });
    await allocation.save(opts(session));
    await recordLedger(
      {
        entryKey: `allocation_held:${allocation.allocationKey}:${sid(disputeId)}`,
        type: "allocation_held",
        amount: allocation.amount - (allocation.refundedAmount || 0),
        direction: "internal",
        parentOrderId: allocation.parentOrderId,
        sellerOrderId,
        allocationId: allocation._id,
        beneficiaryType: "seller",
        beneficiaryId: allocation.beneficiaryId,
        note: reason,
      },
      session
    );
  }
  if (allocation.payoutId) {
    const blocked = await Payout.findOneAndUpdate(
      { _id: allocation.payoutId, status: { $in: ["eligible", "queued", "failed"] } },
      {
        $set: { status: "blocked", failureCode: "DISPUTE", failureMessage: reason },
        $push: { history: { status: "blocked", at: new Date(), note: reason } },
      },
      { new: true, ...opts(session) }
    );
    if (blocked) await Order.updateOne({ _id: sellerOrderId }, { $set: { payoutStatus: "blocked" } }, opts(session));
    if (!blocked) {
      const current = await Payout.findById(allocation.payoutId, null, opts(session)).lean();
      if (current && (current.status === "processing" || current.status === "unknown")) {
        await auditFinance(
          {
            actorType: "system",
            action: "dispute.payout_in_flight",
            targetType: "Payout",
            targetId: current._id,
            severity: "warning",
            meta: { reason, status: current.status },
          },
          session
        );
      }
    }
  }
  return allocation;
}

/** Lève le blocage ; le reversement reprend s'il était déjà dû. */
export async function releaseSellerOrderHold(sellerOrderId: unknown, note: string, session: Session) {
  const allocation = await sellerAllocationFor(sellerOrderId, session);
  if (!allocation || !allocation.hold?.active) return allocation;
  allocation.hold = { active: false, reason: "", disputeId: null, at: null } as any;
  allocation.history.push({ status: allocation.status, at: new Date(), note: `Déblocage : ${note}` });
  await allocation.save(opts(session));
  await recordLedger(
    {
      entryKey: `allocation_released:${allocation.allocationKey}:${Date.now()}`,
      type: "allocation_released",
      amount: allocation.amount - (allocation.refundedAmount || 0),
      direction: "internal",
      parentOrderId: allocation.parentOrderId,
      sellerOrderId,
      allocationId: allocation._id,
      beneficiaryType: "seller",
      beneficiaryId: allocation.beneficiaryId,
      note,
    },
    session
  );
  if (allocation.payoutId) {
    await requeueBlockedPayout(allocation.payoutId, session);
  }
  return allocation;
}

// ─── Remboursements ──────────────────────────────────────────────────────────

/**
 * Rembourse une part `ratio` (0–1) d'une sous-commande : opération distincte, traçable,
 * qui ajuste les sommes dues (refundedAmount) sans jamais supprimer l'historique.
 */
export async function createSellerOrderRefund(
  input: {
    sellerOrderId: unknown;
    ratio: number;
    reason: string;
    actorId?: unknown;
    disputeId?: unknown;
  },
  session: Session
) {
  const ratio = Math.min(1, Math.max(0, input.ratio));
  if (ratio <= 0) return null;
  const order = await Order.findById(input.sellerOrderId, null, opts(session));
  if (!order?.parentOrderId) throw badRequest("NOT_FINANCIAL", "Commande hors du système financier.");
  const parent = await ParentOrder.findById(order.parentOrderId, null, opts(session));
  if (!parent || parent.payment?.status === "pending" || parent.payment?.status === "failed") {
    throw badRequest("NOT_PAID", "Le paiement de cette commande n'est pas confirmé.");
  }
  const existing = await Refund.findOne(
    { sellerOrderId: order._id, status: { $in: ["requested", "processing", "succeeded", "requires_manual"] }, kind: { $ne: "late_payment" } },
    null,
    opts(session)
  );
  if (existing) return existing;

  const details = order.financialDetails || ({} as any);
  const seller = await sellerAllocationFor(order._id, session);
  if (!seller) throw notFound("Allocation vendeur introuvable");
  const sellerPayout = seller.payoutId ? await Payout.findById(seller.payoutId, null, opts(session)) : null;
  if (sellerPayout && (sellerPayout.status === "processing" || sellerPayout.status === "unknown")) {
    throw conflict("PAYOUT_IN_FLIGHT", "Un reversement vendeur est en cours : attends son résultat avant de rembourser.");
  }
  const sellerAlreadyPaid = seller.status === "paid";
  const sellerNet = money(details.sellerNetAmount ?? seller.amount);
  const commission = money(details.platformCommissionAmount ?? 0);

  const adjustments: Array<{ allocationId: unknown; beneficiaryType: string; amount: number }> = [];
  const sellerPart = Math.min(Math.round(sellerNet * ratio), seller.amount - (seller.refundedAmount || 0));
  if (sellerPart > 0) adjustments.push({ allocationId: seller._id, beneficiaryType: "seller", amount: sellerPart });

  const platform = await FinancialAllocation.findOne(
    { parentOrderId: parent._id, beneficiaryType: "platform" },
    null,
    opts(session)
  );
  const platformPart = platform
    ? Math.min(Math.round(commission * ratio), platform.amount - (platform.refundedAmount || 0))
    : 0;
  if (platform && platformPart > 0) {
    adjustments.push({ allocationId: platform._id, beneficiaryType: "platform", amount: platformPart });
  }
  // Frais de livraison rendus seulement si la livraison n'a jamais été confirmée.
  if (ratio === 1 && order.deliveryId) {
    const courier = await courierAllocationFor(order.deliveryId, session);
    if (courier && (courier.status === "funded" || courier.status === "awaiting_payment")) {
      adjustments.push({ allocationId: courier._id, beneficiaryType: "courier", amount: courier.amount - (courier.refundedAmount || 0) });
    }
  }
  const amount = adjustments.reduce((s, a) => s + a.amount, 0);
  if (amount <= 0) return null;

  const refundId = new mongoose.Types.ObjectId();
  for (const adj of adjustments) {
    const a = await FinancialAllocation.findById(adj.allocationId, null, opts(session));
    if (!a) continue;
    a.refundedAmount = (a.refundedAmount || 0) + adj.amount;
    const remaining = a.amount - a.refundedAmount;
    if (remaining <= 0 && a.status !== "paid") a.status = "refunded";
    a.history.push({ status: a.status, at: new Date(), note: `Remboursement ${adj.amount} GNF : ${input.reason}` });
    await a.save(opts(session));
    if (a.payoutId && a.status === "refunded") await cancelOpenPayout(a.payoutId, "Allocation remboursée", session);
  }
  const [refund] = await Refund.create(
    [
      {
        _id: refundId,
        refundReference: `${parent.orderNumber}-R-${shortId(order._id)}`,
        parentOrderId: parent._id,
        sellerOrderId: order._id,
        paymentId: parent.payment?.paymentId,
        disputeId: input.disputeId || null,
        buyerId: order.buyerId,
        amount,
        reason: input.reason,
        kind: ratio === 1 ? "full" : "partial",
        status: "requested",
        allocationAdjustments: adjustments,
        sellerAlreadyPaid,
        recoveryStatus: sellerAlreadyPaid && sellerPart > 0 ? "required" : "none",
        createdBy: input.actorId || null,
        history: [{ status: "requested", at: new Date(), note: input.reason }],
      },
    ],
    opts(session)
  );
  await recordLedger(
    {
      entryKey: `refund_created:${refund!.refundReference}`,
      type: "refund_created",
      amount,
      direction: "out",
      parentOrderId: parent._id,
      sellerOrderId: order._id,
      refundId,
      beneficiaryType: "buyer",
      beneficiaryId: order.buyerId,
      reference: refund!.refundReference,
      note: input.reason,
    },
    session
  );
  // Vendeur non encore payé : son reversement est ramené au montant restant dû.
  if (!sellerAlreadyPaid && seller.status !== "refunded" && seller.payoutId) {
    await resizeOpenPayout(seller.payoutId, seller.amount - seller.refundedAmount, session);
  }
  await createRefundPayout(refund!, order, session);
  await Order.updateOne(
    { _id: order._id },
    { $set: { payoutStatus: seller.status === "refunded" ? "refunded" : order.payoutStatus } },
    opts(session)
  );
  return refund;
}

/** Statut global du ParentOrder, dérivé de ses sous-commandes (jamais de l'encaissement seul). */
export async function refreshParentOrderStatus(parentOrderId: unknown, session: Session = null) {
  const parent = await ParentOrder.findById(parentOrderId, null, opts(session));
  if (!parent || parent.payment?.status === "pending" || parent.payment?.status === "failed") return parent;
  const orders = await Order.find({ _id: { $in: parent.sellerOrderIds } }, "status buyerConfirmedAt", opts(session)).lean();
  const done = (o: any) => ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING", "REFUNDED"].includes(String(o.status));
  let status: string = "paid";
  if (orders.some((o) => o.status === "DISPUTED")) status = "disputed";
  else if (orders.length && orders.every(done)) status = "completed";
  else if (orders.some(done)) status = "partially_delivered";
  else if (orders.some((o) => !["SELLER_NOTIFIED", "PAID", "ORDERED"].includes(String(o.status)))) status = "processing";
  if (parent.status !== status && parent.status !== "cancelled") {
    parent.status = status as any;
    await parent.save(opts(session));
  }
  // Commission reconnue (conservée sur le compte marchand) quand toutes les sommes vendeurs sont soldées.
  const sellerAllocs = await FinancialAllocation.find({ parentOrderId, beneficiaryType: "seller" }, "status", opts(session)).lean();
  if (sellerAllocs.length && sellerAllocs.every((a) => a.status === "paid" || a.status === "refunded")) {
    const platform = await FinancialAllocation.findOne({ parentOrderId, beneficiaryType: "platform" }, null, opts(session));
    if (platform && platform.status === "funded") {
      platform.status = "retained";
      platform.history.push({ status: "retained", at: new Date(), note: "Conservée sur le compte marchand" });
      await platform.save(opts(session));
      await recordLedger(
        {
          entryKey: `commission_recognized:${platform.allocationKey}`,
          type: "commission_recognized",
          amount: platform.amount - (platform.refundedAmount || 0),
          direction: "internal",
          parentOrderId,
          allocationId: platform._id,
          beneficiaryType: "platform",
          beneficiaryId: PLATFORM_BENEFICIARY,
        },
        session
      );
    }
  }
  return parent;
}
