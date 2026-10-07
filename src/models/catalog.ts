import mongoose, { Schema } from "mongoose";

const DESTINATIONS = [
  "SECONDE_MAIN",
  "ARTICLES_NEUFS",
  "QUARTIER_BOUTIQUES",
  "ENSEIGNES",
] as const;

const categorySchema = new Schema(
  {
    parentId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    nameFr: { type: String, required: true },
    nameEn: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    destination: { type: String, enum: DESTINATIONS, required: false, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    imageUrl: { type: String, default: null },
    imagePublicId: { type: String, default: null },
  },
  { timestamps: true }
);

const zoneSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    nameFr: { type: String, required: true },
    nameEn: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const tariffSchema = new Schema({
  fromZoneId: { type: Schema.Types.ObjectId, ref: "Zone", required: true },
  toZoneId: { type: Schema.Types.ObjectId, ref: "Zone", required: true },
  amountGnf: { type: Number, required: true },
});
tariffSchema.index({ fromZoneId: 1, toZoneId: 1 }, { unique: true });

const settingsSchema = new Schema(
  {
    key: { type: String, unique: true, default: "default" },
    commissionRateStandard: { type: Number, default: 0.08 },
    commissionRateProximite: { type: Number, default: 0.05 },
    disputeWindowHours: { type: Number, default: 72 },
    minWithdrawalGnf: { type: Number, default: 10000 },
    maxListingPhotos: { type: Number, default: 10 },
    maintenanceMode: { type: Boolean, default: false },
    platformName: { type: String, default: "FripCash" },
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    notifyEmail: { type: Boolean, default: true },
    notifySms: { type: Boolean, default: true },
    notifyDisputes: { type: Boolean, default: true },
    notifyNewUsers: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const partnerSchema = new Schema(
  {
    name: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    kind: { type: String, default: "enseigne" },
    status: { type: String, default: "active" },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

export const Category = mongoose.model("Category", categorySchema);
export const Zone = mongoose.model("Zone", zoneSchema);
export const DeliveryTariff = mongoose.model("DeliveryTariff", tariffSchema);
export const PlatformSettings = mongoose.model("PlatformSettings", settingsSchema);
export const Partner = mongoose.model("Partner", partnerSchema);
