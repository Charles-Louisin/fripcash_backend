/**
 * Système financier marketplace (spécification paiement.md).
 *
 * Correspondance avec l'existant : la collection `orders` (modèle `Order`) contient déjà UNE commande
 * par vendeur — c'est la SellerOrder. `ParentOrder` regroupe les SellerOrders d'un même panier.
 * Cycles de vie séparés : SellerOrder (préparer / livrer) ≠ Payout (argent à envoyer).
 */
import mongoose, { Schema } from "mongoose";

const ObjectId = Schema.Types.ObjectId;

function immutable(schema: Schema, label: string) {
  const refuse = function (this: any, next: (err?: Error) => void) {
    // Seule exception : un upsert « insérer si absent » ($setOnInsert), qui ne modifie jamais l'existant.
    const update = typeof this.getUpdate === "function" ? this.getUpdate() : null;
    if (update && Object.keys(update).length && Object.keys(update).every((k) => k === "$setOnInsert")) {
      return next();
    }
    next(new Error(`${label} est immuable : enregistre une écriture de correction.`));
  };
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
    schema.pre(op as any, refuse as any);
  }
  schema.pre("save", function (next) {
    if (!this.isNew) return next(new Error(`${label} est immuable.`));
    next();
  });
}

const statusHistory = {
  type: [{ status: String, at: { type: Date, default: Date.now }, note: { type: String, default: "" } }],
  default: [],
};

// ─── ParentOrder ─────────────────────────────────────────────────────────────

const parentOrderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    buyerId: { type: ObjectId, ref: "User", required: true, index: true },
    sellerOrderIds: [{ type: ObjectId, ref: "Order" }],
    deliveryIds: [{ type: ObjectId, ref: "Delivery" }],
    currency: { type: String, default: "GNF" },
    summary: {
      productsSubtotal: { type: Number, default: 0 },
      discounts: { type: Number, default: 0 },
      deliveryTotal: { type: Number, default: 0 },
      serviceFees: { type: Number, default: 0 },
      totalPaid: { type: Number, required: true },
    },
    payment: {
      paymentId: { type: ObjectId, ref: "Payment", default: null },
      provider: { type: String, default: "chapchappay" },
      providerTransactionId: { type: String, default: "" },
      status: {
        type: String,
        enum: ["pending", "paid", "failed", "partially_refunded", "refunded"],
        default: "pending",
      },
    },
    financialSummary: {
      sellersTotal: { type: Number, default: 0 },
      courierTotal: { type: Number, default: 0 },
      platformCommission: { type: Number, default: 0 },
      providerFees: { type: Number, default: 0 },
      totalAllocated: { type: Number, default: 0 },
    },
    status: {
      type: String,
      enum: ["pending_payment", "paid", "processing", "partially_delivered", "completed", "cancelled", "disputed"],
      default: "pending_payment",
      index: true,
    },
  },
  { timestamps: true }
);

// ─── Delivery ────────────────────────────────────────────────────────────────

const deliverySchema = new Schema(
  {
    /** Une prestation facturée = une clé : empêche deux Delivery (et deux rémunérations) pour le même colis. */
    deliveryKey: { type: String, required: true, unique: true },
    parentOrderId: { type: ObjectId, ref: "ParentOrder", required: true, index: true },
    sellerOrderIds: [{ type: ObjectId, ref: "Order" }],
    courierId: { type: ObjectId, ref: "User", default: null, index: true },
    deliveryFee: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "GNF" },
    status: {
      type: String,
      enum: ["awaiting_courier", "assigned", "accepted", "picked_up", "in_transit", "delivered", "confirmed", "failed", "disputed"],
      default: "awaiting_courier",
    },
    confirmation: {
      method: { type: String, enum: ["otp", "buyer_confirmation", "admin_validation", null], default: null },
      confirmedAt: { type: Date, default: null },
      confirmedBy: { type: ObjectId, ref: "User", default: null },
    },
    courierPayoutId: { type: ObjectId, ref: "Payout", default: null },
    history: statusHistory,
  },
  { timestamps: true }
);

// ─── FinancialAllocation ─────────────────────────────────────────────────────

const allocationSchema = new Schema(
  {
    /** Une somme due = une clé unique : une allocation n'est jamais créée deux fois. */
    allocationKey: { type: String, required: true, unique: true },
    parentOrderId: { type: ObjectId, ref: "ParentOrder", required: true, index: true },
    sellerOrderId: { type: ObjectId, ref: "Order", default: null, index: true },
    deliveryId: { type: ObjectId, ref: "Delivery", default: null, index: true },
    beneficiaryType: { type: String, enum: ["seller", "courier", "platform"], required: true },
    /** ObjectId du vendeur/livreur ; "fripcash" pour la commission ; null tant que le livreur n'est pas affecté. */
    beneficiaryId: { type: Schema.Types.Mixed, default: null },
    /** Photographie financière figée à la commande : jamais modifiée. */
    amount: { type: Number, required: true, min: 0 },
    /** Part déjà rendue à l'acheteur (litige/remboursement) : la somme due devient amount − refundedAmount. */
    refundedAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "GNF" },
    status: {
      type: String,
      enum: ["awaiting_payment", "funded", "eligible", "payout_pending", "paid", "retained", "failed", "refunded"],
      default: "awaiting_payment",
      index: true,
    },
    hold: {
      active: { type: Boolean, default: false },
      reason: { type: String, default: "" },
      disputeId: { type: ObjectId, ref: "Dispute", default: null },
      at: { type: Date, default: null },
    },
    commissionRate: { type: Number, default: null },
    payoutId: { type: ObjectId, ref: "Payout", default: null },
    history: statusHistory,
  },
  { timestamps: true }
);

// ─── Payout & tentatives ─────────────────────────────────────────────────────

const payoutSchema = new Schema(
  {
    payoutReference: { type: String, required: true, unique: true },
    parentOrderId: { type: ObjectId, ref: "ParentOrder", required: true, index: true },
    allocationId: { type: ObjectId, ref: "FinancialAllocation", default: null },
    refundId: { type: ObjectId, ref: "Refund", default: null },
    sellerOrderId: { type: ObjectId, ref: "Order", default: null },
    deliveryId: { type: ObjectId, ref: "Delivery", default: null },
    /** buyer = exécution d'un remboursement (Refund) avec la même mécanique anti-doublon. */
    beneficiaryType: { type: String, enum: ["seller", "courier", "buyer"], required: true },
    beneficiaryId: { type: ObjectId, ref: "User", required: true, index: true },
    destination: {
      operator: { type: String, default: "" },
      channel: { type: String, default: "" },
      phoneNumber: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      accountName: { type: String, default: "" },
    },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: "GNF" },
    provider: { type: String, default: "chapchappay" },
    providerPayoutId: { type: String, default: "" },
    status: {
      type: String,
      enum: ["blocked", "eligible", "queued", "processing", "succeeded", "failed", "unknown", "cancelled"],
      required: true,
      index: true,
    },
    attemptsCount: { type: Number, default: 0 },
    verifyCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },
    failureCode: { type: String, default: "" },
    failureMessage: { type: String, default: "" },
    completedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
    batchId: { type: ObjectId, ref: "PayoutBatch", default: null },
    history: statusHistory,
  },
  { timestamps: true }
);
// Un seul Payout par allocation (les remboursements, sans allocation, sont exclus).
payoutSchema.index(
  { allocationId: 1 },
  { unique: true, partialFilterExpression: { allocationId: { $type: "objectId" } } }
);
payoutSchema.index(
  { refundId: 1 },
  { unique: true, partialFilterExpression: { refundId: { $type: "objectId" } } }
);
payoutSchema.index({ status: 1, nextRetryAt: 1 });

const payoutAttemptSchema = new Schema({
  payoutId: { type: ObjectId, ref: "Payout", required: true, index: true },
  attemptNumber: { type: Number, required: true },
  /** Envoyée au prestataire comme `order_id` : permet de retrouver le transfert après un timeout. */
  attemptReference: { type: String, required: true, unique: true },
  providerReference: { type: String, default: "" },
  status: {
    type: String,
    enum: ["created", "processing", "succeeded", "failed", "unknown"],
    default: "created",
  },
  requestPayload: { type: Schema.Types.Mixed, default: {} },
  responsePayload: { type: Schema.Types.Mixed, default: null },
  failureCode: { type: String, default: "" },
  failureMessage: { type: String, default: "" },
  workerId: { type: String, default: "" },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
});
payoutAttemptSchema.index({ payoutId: 1, attemptNumber: 1 }, { unique: true });

const payoutBatchSchema = new Schema({
  batchReference: { type: String, required: true, unique: true },
  provider: { type: String, default: "chapchappay" },
  payoutIds: [{ type: ObjectId, ref: "Payout" }],
  totalAmount: { type: Number, default: 0 },
  currency: { type: String, default: "GNF" },
  status: {
    type: String,
    enum: ["created", "submitted", "processing", "completed", "partially_completed", "failed", "unknown"],
    default: "created",
  },
  /** Chap Chap Pay n'expose pas de PUSH groupé : chaque élément part en requête individuelle. */
  providerBatchId: { type: String, default: "" },
  results: {
    type: [{ payoutId: ObjectId, payoutReference: String, status: String, failureCode: String }],
    default: [],
  },
  createdBy: { type: ObjectId, ref: "User", default: null },
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

// ─── Webhooks reçus ──────────────────────────────────────────────────────────

const webhookFields = {
  provider: { type: String, required: true },
  /** provider:référence:statut — un même événement rejoué n'est enregistré qu'une fois. */
  eventKey: { type: String, required: true, unique: true },
  reference: { type: String, default: "", index: true },
  orderId: { type: String, default: "" },
  statusCode: { type: String, default: "" },
  signatureValid: { type: Boolean, default: false },
  payload: { type: Schema.Types.Mixed, default: {} },
  duplicates: { type: Number, default: 0 },
  receivedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
  outcome: { type: String, default: "" },
};
const paymentWebhookEventSchema = new Schema(webhookFields);
const payoutWebhookEventSchema = new Schema(webhookFields);

// ─── Ledger immuable ─────────────────────────────────────────────────────────

const financialLedgerSchema = new Schema(
  {
    /** Clé métier unique : rejouer un traitement ne double jamais une écriture. */
    entryKey: { type: String, required: true, unique: true },
    type: {
      type: String,
      required: true,
      enum: [
        "payment_confirmed",
        "allocation_created",
        "allocation_eligible",
        "allocation_held",
        "allocation_released",
        "commission_recognized",
        "payout_requested",
        "payout_succeeded",
        "payout_failed",
        "payout_unknown",
        "refund_created",
        "refund_succeeded",
        "adjustment",
        "late_payment_detected",
      ],
    },
    parentOrderId: { type: ObjectId, ref: "ParentOrder", default: null, index: true },
    sellerOrderId: { type: ObjectId, ref: "Order", default: null },
    paymentId: { type: ObjectId, ref: "Payment", default: null },
    allocationId: { type: ObjectId, ref: "FinancialAllocation", default: null },
    payoutId: { type: ObjectId, ref: "Payout", default: null },
    attemptId: { type: ObjectId, ref: "PayoutAttempt", default: null },
    refundId: { type: ObjectId, ref: "Refund", default: null },
    beneficiaryType: { type: String, default: "" },
    beneficiaryId: { type: String, default: "" },
    amount: { type: Number, required: true },
    direction: { type: String, enum: ["in", "out", "internal"], required: true },
    currency: { type: String, default: "GNF" },
    reference: { type: String, default: "" },
    note: { type: String, default: "" },
    occurredAt: { type: Date, default: Date.now },
  },
  { collection: "financialledger" }
);
immutable(financialLedgerSchema, "Le ledger financier");

// ─── Remboursements ──────────────────────────────────────────────────────────

const refundSchema = new Schema(
  {
    refundReference: { type: String, required: true, unique: true },
    parentOrderId: { type: ObjectId, ref: "ParentOrder", required: true, index: true },
    sellerOrderId: { type: ObjectId, ref: "Order", default: null },
    paymentId: { type: ObjectId, ref: "Payment", default: null },
    disputeId: { type: ObjectId, ref: "Dispute", default: null },
    buyerId: { type: ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "GNF" },
    reason: { type: String, default: "" },
    kind: { type: String, enum: ["full", "partial", "late_payment"], default: "full" },
    status: {
      type: String,
      enum: ["requested", "processing", "succeeded", "failed", "requires_manual", "cancelled"],
      default: "requested",
    },
    allocationAdjustments: {
      type: [{ allocationId: ObjectId, beneficiaryType: String, amount: Number }],
      default: [],
    },
    /** Vendeur déjà payé : un recouvrement séparé est nécessaire, l'ancien Payout reste intact. */
    sellerAlreadyPaid: { type: Boolean, default: false },
    recoveryStatus: { type: String, enum: ["none", "required", "recovered"], default: "none" },
    payoutId: { type: ObjectId, ref: "Payout", default: null },
    createdBy: { type: ObjectId, ref: "User", default: null },
    history: statusHistory,
  },
  { timestamps: true }
);

// ─── Audit financier immuable ────────────────────────────────────────────────

const financialAuditSchema = new Schema(
  {
    actorId: { type: ObjectId, ref: "User", default: null },
    actorType: { type: String, enum: ["admin", "system", "buyer", "seller", "courier", "provider"], required: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: "" },
    targetId: { type: String, default: "", index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "info" },
    ip: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { collection: "financialauditlogs" }
);
immutable(financialAuditSchema, "Le journal d'audit financier");

// ─── File persistante (outbox) et baux de worker ─────────────────────────────

const outboxSchema = new Schema(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    /** Empêche d'empiler deux fois la même action (ex. exécuter la tentative n°2 du Payout X). */
    dedupeKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "processing", "done", "failed", "dead"], default: "pending" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 10 },
    nextRunAt: { type: Date, default: Date.now },
    lockedBy: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
outboxSchema.index({ status: 1, nextRunAt: 1 });

const workerLeaseSchema = new Schema({
  name: { type: String, required: true, unique: true },
  holder: { type: String, default: "" },
  expiresAt: { type: Date, default: () => new Date(0) },
  lastRunAt: { type: Date, default: null },
});

export const ParentOrder = mongoose.model("ParentOrder", parentOrderSchema);
export const Delivery = mongoose.model("Delivery", deliverySchema);
export const FinancialAllocation = mongoose.model("FinancialAllocation", allocationSchema);
export const Payout = mongoose.model("Payout", payoutSchema);
export const PayoutAttempt = mongoose.model("PayoutAttempt", payoutAttemptSchema);
export const PayoutBatch = mongoose.model("PayoutBatch", payoutBatchSchema);
export const PaymentWebhookEvent = mongoose.model("PaymentWebhookEvent", paymentWebhookEventSchema);
export const PayoutWebhookEvent = mongoose.model("PayoutWebhookEvent", payoutWebhookEventSchema);
export const FinancialLedgerEntry = mongoose.model("FinancialLedgerEntry", financialLedgerSchema);
export const Refund = mongoose.model("Refund", refundSchema);
export const FinancialAuditLog = mongoose.model("FinancialAuditLog", financialAuditSchema);
export const OutboxEvent = mongoose.model("OutboxEvent", outboxSchema);
export const WorkerLease = mongoose.model("WorkerLease", workerLeaseSchema);
