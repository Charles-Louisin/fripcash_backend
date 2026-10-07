import mongoose, { Schema } from "mongoose";

const mediaSchema = new Schema({
  storageKey: { type: String, required: true },
  url: { type: String, default: null },
  mimeType: { type: String, default: "image/jpeg" },
  sortOrder: { type: Number, default: 0 },
});

const listingSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    zoneId: { type: Schema.Types.ObjectId, ref: "Zone", default: null },
    title: { type: String, required: true },
    description: { type: String, default: null },
    netPriceGnf: { type: Number, required: true },
    priceGnf: { type: Number, required: true },
    commissionRate: { type: Number, required: true },
    commissionAmountGnf: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 0 },
    negotiable: { type: Boolean, default: false },
    discountEnabled: { type: Boolean, default: false },
    compareAtPriceGnf: { type: Number, default: null },
    status: {
      type: String,
      enum: ["DRAFT", "ACTIVE", "SOLD", "SOLD_OUT", "REJECTED", "FLAGGED", "ARCHIVED"],
      default: "ACTIVE",
      index: true,
    },
    destination: {
      type: String,
      enum: ["SECONDE_MAIN", "ARTICLES_NEUFS", "QUARTIER_BOUTIQUES", "ENSEIGNES"],
      required: true,
    },
    conditionNote: { type: String, default: null },
    publishedAt: { type: Date, default: Date.now },
    media: { type: [mediaSchema], default: [] },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

listingSchema.index({ status: 1, destination: 1 });
listingSchema.index({ categoryId: 1 });

export const Listing = mongoose.model("Listing", listingSchema);

const librarySchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    payloadJson: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export const LibraryItem = mongoose.model("LibraryItem", librarySchema);
