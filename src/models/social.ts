import mongoose, { Schema } from "mongoose";

const offerSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountGnf: { type: Number, required: true },
    message: { type: String, default: "" },
    status: { type: String, enum: ["pending", "accepted", "refused"], default: "pending" },
  },
  { timestamps: true }
);

const conversationSchema = new Schema(
  {
    participantIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", default: null },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    lastMessage: { type: String, default: "" },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
conversationSchema.index({ participantIds: 1 });

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true },
  },
  { timestamps: true }
);

const favoriteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
  },
  { timestamps: true }
);
favoriteSchema.index({ userId: 1, listingId: 1 }, { unique: true });

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    data: { type: Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const commentSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Comment", default: null },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const reviewSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, default: "" },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const pushDeviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true },
    platform: { type: String, default: "web" },
    audience: { type: String, default: "CONSUMER" },
  },
  { timestamps: true }
);
pushDeviceSchema.index({ userId: 1, token: 1 }, { unique: true });

const sellerLikeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
sellerLikeSchema.index({ userId: 1, sellerId: 1 }, { unique: true });

export const Offer = mongoose.model("Offer", offerSchema);
export const SellerLike = mongoose.model("SellerLike", sellerLikeSchema);
export const PushDevice = mongoose.model("PushDevice", pushDeviceSchema);
export const Conversation = mongoose.model("Conversation", conversationSchema);
export const Message = mongoose.model("Message", messageSchema);
export const Favorite = mongoose.model("Favorite", favoriteSchema);
export const Notification = mongoose.model("Notification", notificationSchema);
export const Comment = mongoose.model("Comment", commentSchema);
export const Review = mongoose.model("Review", reviewSchema);
