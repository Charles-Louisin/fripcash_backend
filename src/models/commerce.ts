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
      enum: ["held", "released", "refunded"],
      default: "held",
    },
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

export const Cart = mongoose.model("Cart", cartSchema);
export const Order = mongoose.model("Order", orderSchema);
export const Wallet = mongoose.model("Wallet", walletSchema);
export const Ledger = mongoose.model("Ledger", ledgerSchema);
