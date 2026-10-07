import "dotenv/config";

function required(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT || 5000),
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: required("MONGODB_URI", "mongodb://127.0.0.1:27017/fripcash"),
  jwtSecret: required("JWT_SECRET", "change-me-fripcash-jwt-secret"),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  otpDevEcho: (process.env.OTP_DEV_ECHO ?? "true") !== "false",
  uploadthingToken: process.env.UPLOADTHING_TOKEN || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  resendFrom: process.env.RESEND_FROM || "FripCash <onboarding@resend.dev>",
};

export const isDev = env.nodeEnv !== "production";
