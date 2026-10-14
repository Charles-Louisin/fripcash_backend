import mongoose, { Schema } from "mongoose";

const cartItemSchema = new Schema({
  listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
  quantity: { type: Number, required: true, min: 1 },
});

const cartSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true }
);

const orderItemSchema = new Schema({
  listingId: { type: Schema.Types.ObjectId, ref: "Listing" },
  title: String,
  quantity: Number,
  priceGnf: Number,
  netPriceGnf: Number,
  commissionGnf: Number,
  imageUrl: { type: String, default: "" },
});

const orderSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    courierId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    items: { type: [orderItemSchema], default: [] },
    amountGnf: { type: Number, required: true },
    shippingCostGnf: { type: Number, default: 0 },
    commissionGnf: { type: Number, default: 0 },
    status: { type: String, required: true, index: true },
    escrowStatus: {
      type: String,
      enum: ["pending", "held", "payout_pending", "refund_pending", "released", "refunded"],
      default: "pending",
    },
    paymentMerchantId: { type: String, default: null, index: true },
    payoutMerchantId: { type: String, default: null },
    fulfillmentMode: {
      type: String,
      enum: ["courier", "pickup", "shopLocalDelivery"],
      default: "courier",
    },
    paymentMethod: { type: String, default: "orange_money" },
    pickupCode: { type: String, default: null },
    pickupZoneId: { type: Schema.Types.ObjectId, ref: "Zone", default: null },
    notifiedCourierIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    address: { type: Schema.Types.Mixed, default: {} },
    disputeReason: { type: String, default: null },
    offerAmountGnf: { type: Number, default: null },
    originalAmountGnf: { type: Number, default: null },
    offerStatus: {
      type: String,
      enum: ["none", "pending", "accepted", "refused"],
      default: "none",
    },
    courierName: { type: String, default: null },
    timeline: {
      type: [{ status: String, at: Date, note: String }],
      default: [],
    },
  },
  { timestamps: true }
);

const walletSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  availableGnf: { type: Number, default: 0 },
  reservedGnf: { type: Number, default: 0 },
});

const ledgerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    type: { type: String, required: true },
    amountGnf: { type: Number, required: true },
    isCredit: { type: Boolean, required: true },
    label: { type: String, default: "" },
  },
  { timestamps: true }
);

const reservedLineSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    quantity: { type: Number, required: true },
  },
  { _id: false }
);

const paymentSchema = new Schema(
  {
    merchantTransactionId: { type: String, required: true, unique: true },
    cinetpayTransactionId: { type: String, default: "", index: true },
    notifyToken: { type: String, default: "" },
    kind: {
      type: String,
      enum: ["payment", "payout", "refund", "withdrawal"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "success", "failed", "expired"],
      default: "pending",
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["OM_GN", "MTN_GN", "CINETPAY"],
      required: true,
    },
    amountGnf: { type: Number, required: true },
    currency: { type: String, default: "GNF" },
    phoneE164: { type: String, default: "" },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    orderIds: [{ type: Schema.Types.ObjectId, ref: "Order" }],
    reservedLines: { type: [reservedLineSchema], default: [] },
    lastNotifyTransactionId: { type: String, default: "" },
    processedAt: { type: Date, default: null },
    message: { type: String, default: "" },
    paymentUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

export const Cart = mongoose.model("Cart", cartSchema);
export const Order = mongoose.model("Order", orderSchema);
export const Wallet = mongoose.model("Wallet", walletSchema);
export const Ledger = mongoose.model("Ledger", ledgerSchema);
export const Payment = mongoose.model("Payment", paymentSchema);
