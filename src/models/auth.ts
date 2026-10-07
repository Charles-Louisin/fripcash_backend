import mongoose, { Schema } from "mongoose";

const otpSchema = new Schema({
  phone: { type: String, required: true, index: true },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

const resetSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  token: { type: String, required: true, index: true },
  kind: { type: String, enum: ["email_verify", "password_reset"], required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true },
    audience: { type: String, required: true },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

export const OtpCode = mongoose.model("OtpCode", otpSchema);
export const AuthToken = mongoose.model("AuthToken", resetSchema);
export const Session = mongoose.model("Session", sessionSchema);
