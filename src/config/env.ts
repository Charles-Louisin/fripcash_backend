import "dotenv/config";

function required(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

const cinetpayKey = (process.env.CINETPAY_ACCOUNT_KEY || "").trim();
const cinetpayEnvRaw = (process.env.CINETPAY_ENV || "").toLowerCase();
const cinetpayFromEnv =
  cinetpayEnvRaw === "production" || cinetpayEnvRaw === "live"
    ? "live"
    : cinetpayEnvRaw === "sandbox" || cinetpayEnvRaw === "staging"
      ? "sandbox"
      : "";
const cinetpayFromKey = cinetpayKey.startsWith("sk_test_")
  ? "sandbox"
  : cinetpayKey.startsWith("sk_live_")
    ? "live"
    : "";
// CINETPAY_ENV wins: a staging merchant often has sk_live_ but must hit api.cinetpay.net
const cinetpayIsLive = (cinetpayFromEnv || cinetpayFromKey || "sandbox") === "live";

export const env = {
  port: Number(process.env.PORT || 5000),
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: required("MONGODB_URI", "mongodb://127.0.0.1:27017/fripcash"),
  jwtSecret: required("JWT_SECRET", "change-me-fripcash-jwt-secret"),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  publicApiUrl: (process.env.PUBLIC_API_URL || "").replace(/\/$/, ""),
  otpDevEcho: (process.env.OTP_DEV_ECHO ?? "true") !== "false",
  uploadthingToken: process.env.UPLOADTHING_TOKEN || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  resendFrom: process.env.RESEND_FROM || "FripCash <onboarding@resend.dev>",
  cinetpayAccountKey: cinetpayKey,
  cinetpayAccountPassword: (process.env.CINETPAY_ACCOUNT_PASSWORD || "").trim(),
  cinetpayEnv: cinetpayIsLive ? "live" : "sandbox",
  cinetpayEnvSource: cinetpayFromEnv
    ? `env:${cinetpayFromEnv}`
    : cinetpayFromKey
      ? `key:${cinetpayFromKey}`
      : "default:sandbox",
  cinetpaySetupSecret: process.env.CINETPAY_SETUP_SECRET || "",
  cinetpayCurrency: (process.env.CINETPAY_CURRENCY || "GNF").trim().toUpperCase(),
  cinetpayBaseUrl: cinetpayIsLive
    ? "https://api.cinetpay.co"
    : "https://api.cinetpay.net",
};

export const isDev = env.nodeEnv !== "production";
