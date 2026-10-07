import mongoose, { Schema } from "mongoose";

const disputeSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    openedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    openerRole: { type: String, enum: ["buyer", "seller"], required: true },
    reason: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "under_review", "resolved", "closed"],
      default: "open",
    },
    resolution: { type: String, default: null },
    note: { type: String, default: "" },
    evidence: [
      {
        url: String,
        storageKey: String,
        capturedAt: Date,
        uploaderRole: String,
      },
    ],
    messages: [
      {
        senderId: { type: Schema.Types.ObjectId, ref: "User" },
        senderRole: {
          type: String,
          enum: ["admin", "buyer", "seller"],
        },
        body: String,
        fromAdmin: { type: Boolean, default: false },
        kind: {
          type: String,
          enum: ["text", "info_request", "info_response"],
          default: "text",
        },
        requestedKinds: { type: [String], default: [] },
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
  },
  { timestamps: true }
);

const reportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, required: true },
    status: { type: String, default: "open" },
  },
  { timestamps: true }
);

const auditSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true },
    target: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const orgKycSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "resubmit"],
      default: "pending",
    },
    note: { type: String, default: "" },
    documents: [
      {
        documentType: String,
        storageKey: String,
        mimeType: String,
      },
    ],
  },
  { timestamps: true }
);

export const Dispute = mongoose.model("Dispute", disputeSchema);
export const Report = mongoose.model("Report", reportSchema);
export const AuditLog = mongoose.model("AuditLog", auditSchema);
export const OrgKyc = mongoose.model("OrgKyc", orgKycSchema);
