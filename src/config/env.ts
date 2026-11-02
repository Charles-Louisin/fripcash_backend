import "dotenv/config";

function required(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

const chapchapApiKey = (process.env.CHAPCHAPPAY_API_KEY || "").trim();
function bool(name: string, fallback: boolean) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export const env = {
  port: Number(process.env.PORT || 5000),
  nodeEnv,
  mongoUri: required("MONGODB_URI", "mongodb://127.0.0.1:27017/fripcash"),
  jwtSecret: required("JWT_SECRET", "change-me-fripcash-jwt-secret"),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  publicApiUrl: (process.env.PUBLIC_API_URL || "").replace(/\/$/, ""),
  otpDevEcho: !isProduction && (process.env.OTP_DEV_ECHO ?? "true") !== "false",
  /** Aucun fournisseur SMS n'est branché : le code téléphone est 000000 tant que ce n'est pas désactivé. */
  otpSimulated: (process.env.OTP_SIMULATED ?? "true") !== "false",
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? (isProduction ? 400 : 2000)),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  uploadthingToken: process.env.UPLOADTHING_TOKEN || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  resendFrom: process.env.RESEND_FROM || "FripCash <onboarding@resend.dev>",
  expoAccessToken: (process.env.EXPO_ACCESS_TOKEN || "").trim(),
  chapchapBaseUrl: (process.env.CHAPCHAPPAY_BASE_URL || "https://chapchappay.com/api").replace(/\/$/, ""),
  /** Clé de test ou de production : c'est la clé qui détermine le mode chez Chap Chap Pay. */
  chapchapApiKey,
  /** « Clé d'encryptage » du tableau de bord : signe les appels PUSH et les webhooks (HMAC-SHA256). */
  chapchapEncryptionKey: (process.env.CHAPCHAPPAY_ENCRYPTION_KEY || "").trim(),
  /** Code d'accès (6 chiffres) de l'Agent API qui porte la permission PUSH. */
  chapchapPushAccessCode: (process.env.CHAPCHAPPAY_PUSH_ACCESS_CODE || "").trim(),
  /** Mode test uniquement : accepte les numéros fictifs Chap Chap Pay (72… Orange, 76… MTN). Refusé en production. */
  chapchapAcceptTestNumbers: !isProduction && bool("CHAPCHAPPAY_ACCEPT_TEST_NUMBERS", false),
  /** deduct = frais retenus sur le compte marchand (montant client = montant commande). */
  chapchapFeeHandling: ((process.env.CHAPCHAPPAY_FEE_HANDLING || "deduct") === "add" ? "add" : "deduct") as
    | "add"
    | "deduct",
  chapchapMinPaymentGnf: Number(process.env.CHAPCHAPPAY_MIN_PAYMENT_GNF || 5000),
  /** Frais Chap Chap Pay ajoutés au total payé par le client (voir services/finance/fees.ts). */
  chapchapPassFeesToBuyer: bool("CHAPCHAPPAY_PASS_FEES_TO_BUYER", true),
  chapchapFeeRateMobile: Number(process.env.CHAPCHAPPAY_FEE_RATE_MOBILE ?? 0.02),
  chapchapFeeRateOther: Number(process.env.CHAPCHAPPAY_FEE_RATE_OTHER ?? 0.025),
  chapchapFeeFixedGnf: Number(process.env.CHAPCHAPPAY_FEE_FIXED_GNF ?? 200),
  /** Page web de FripCash, utilisée si le paiement n'a pas été lancé depuis l'app. */
  appWebUrl: (process.env.APP_WEB_URL || "https://fripcash.com").replace(/\/$/, ""),
  chapchapMinPayoutGnf: Number(process.env.CHAPCHAPPAY_MIN_PAYOUT_GNF || 1000),
  chapchapTimeoutMs: Number(process.env.CHAPCHAPPAY_TIMEOUT_MS || 20_000),

  /** Lance le worker financier dans le processus API (désactiver si un service worker dédié tourne). */
  financeWorkerEnabled: bool("FINANCE_WORKER_ENABLED", true),
  financeWorkerPollMs: Number(process.env.FINANCE_WORKER_POLL_MS || 5_000),
  /** true : un reversement éligible part seul. false : l'admin le lance (individuel ou par lot). */
  payoutAutoExecute: bool("PAYOUT_AUTO_EXECUTE", true),
  payoutMaxAttempts: Number(process.env.PAYOUT_MAX_ATTEMPTS || 5),
  /** Refuse d'écrire des opérations financières sans transactions MongoDB (replica set requis). */
  financeRequireTransactions: bool("FINANCE_REQUIRE_TRANSACTIONS", isProduction),
};

export const isDev = env.nodeEnv !== "production";

const WEAK_JWT = new Set(["", "change-me-fripcash-jwt-secret", "secret", "jwt-secret"]);

export function assertSecureEnv() {
  if (!isProduction) return;
  if (WEAK_JWT.has(env.jwtSecret) || env.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be a strong unique value in production.");
  }
  if (env.otpDevEcho) {
    throw new Error("OTP_DEV_ECHO cannot be enabled in production.");
  }
  if (!env.chapchapApiKey || !env.chapchapEncryptionKey) {
    throw new Error("CHAPCHAPPAY_API_KEY and CHAPCHAPPAY_ENCRYPTION_KEY are required in production.");
  }
  if (!env.publicApiUrl.startsWith("https://")) {
    throw new Error("PUBLIC_API_URL must be HTTPS: Chap Chap Pay only calls HTTPS webhooks.");
  }
}
