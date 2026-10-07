import mongoose, { Schema } from "mongoose";

const sellerSchema = new Schema(
  {
    kind: { type: String, enum: ["particulier", "boutique"], required: true },
    shopKind: {
      type: String,
      enum: ["standard", "proximite", "enseigne", null],
      default: null,
    },
    shopName: { type: String, default: "" },
    shopDescription: { type: String, default: "" },
    bio: { type: String, default: "" },
    coverUrl: { type: String, default: "" },
    likesCount: { type: Number, default: 0 },
    shopCreatedAt: { type: Date, default: null },
    kycDocuments: [
      {
        url: String,
        storageKey: String,
        mimeType: String,
        name: String,
        documentType: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],
    verificationMessages: [
      {
        senderId: { type: Schema.Types.ObjectId, ref: "User" },
        fromAdmin: { type: Boolean, default: false },
        body: String,
        attachments: [
          {
            url: String,
            storageKey: String,
            mimeType: String,
            name: String,
          },
        ],
        createdAt: { type: Date, default: Date.now },
      },
    ],
    verificationStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
    },
    rejectionReason: { type: String, default: "" },
    listingDestination: { type: String, default: null },
    bundleEnabled: { type: Boolean, default: false },
    bundleMinItems: { type: Number, default: 2 },
    bundleDiscountPercent: { type: Number, default: 0 },
    vacationEnabled: { type: Boolean, default: false },
    vacationStartsAt: { type: Date, default: null },
    vacationEndsAt: { type: Date, default: null },
  },
  { _id: false }
);

const courierSchema = new Schema(
  {
    verificationStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "pending",
    },
    isAvailable: { type: Boolean, default: false },
    zoneId: { type: Schema.Types.ObjectId, ref: "Zone", default: null },
    zoneIds: [{ type: Schema.Types.ObjectId, ref: "Zone" }],
    vehicle: { type: String, default: "" },
    plate: { type: String, default: "" },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, unique: true, sparse: true },
    phone: { type: String, unique: true, sparse: true },
    passwordHash: { type: String, default: null },
    emailVerified: { type: Boolean, default: false },
    phoneNumberVerified: { type: Boolean, default: false },
    preferredLocale: { type: String, enum: ["FR", "EN"], default: "FR" },
    avatarUrl: { type: String, default: "" },
    city: { type: String, default: "" },
    bio: { type: String, default: "" },
    authAudience: {
      type: String,
      enum: ["CONSUMER", "ADMIN", "COURIER"],
      default: "CONSUMER",
    },
    canBuy: { type: Boolean, default: true },
    isAdmin: { type: Boolean, default: false },
    banned: { type: Boolean, default: false },
    banReason: { type: String, default: null },
    seller: { type: sellerSchema, default: null },
    courier: { type: courierSchema, default: null },
    kyc: {
      status: {
        type: String,
        enum: ["none", "pending", "approved", "rejected"],
        default: "none",
      },
      note: { type: String, default: "" },
      documents: [
        {
          documentType: String,
          storageKey: String,
          url: String,
          mimeType: String,
        },
      ],
    },
    notifPrefs: {
      type: [
        {
          type: { type: String },
          pushEnabled: { type: Boolean, default: true },
          emailEnabled: { type: Boolean, default: true },
          smsEnabled: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

userSchema.index({ authAudience: 1 });
userSchema.index({ "seller.verificationStatus": 1 });

export const User = mongoose.model("User", userSchema);
