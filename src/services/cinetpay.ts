import { createHash, timingSafeEqual } from "crypto";
import { env } from "../config/env.js";
import { badGateway, badRequest } from "../utils/http-error.js";
import { logger } from "../utils/logger.js";

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_SKEW_MS = 30_000;

export type CinetPayMethod = "OM_GN" | "MTN_GN" | "CINETPAY";

export type CinetPayStatus =
  | "SUCCESS"
  | "FAILED"
  | "PENDING"
  | "INITIATED"
  | "EXPIRED"
  | "INSUFFICIENT_BALANCE"
  | "OTP_ERROR"
  | "OTP_EXPIRED"
  | "TRANSACTION_EXIST"
  | "OK"
  | string;

export type CinetPayApiResult = {
  code: number;
  status: CinetPayStatus;
  message: string;
  merchantTransactionId?: string;
  transactionId?: string;
  notifyToken?: string;
  paymentUrl?: string;
  paymentToken?: string;
  mustRedirect: boolean;
  amount?: number;
  feeAmount?: number;
  raw: Record<string, unknown>;
};

const STATUS_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Configuration paiement invalide. Réessaie plus tard.",
  INVALID_PARAMS: "Paramètres de paiement invalides.",
  EXPIRED_TOKEN: "Session CinetPay expirée. Réessaie.",
  INVALID_TOKEN: "Session CinetPay invalide. Réessaie.",
  TRANSACTION_EXIST: "Cette transaction existe déjà.",
  INITIATED: "Paiement initié. Continue pour confirmer.",
  PENDING: "Paiement en cours. Confirme sur ton téléphone.",
  EXPIRED: "Le paiement a expiré. Relance-le.",
  OTP_ERROR: "Code OTP incorrect.",
  OTP_EXPIRED: "Code OTP expiré. Demande un nouveau code.",
  INSUFFICIENT_BALANCE: "Solde insuffisant pour cette opération.",
  USER_NOT_FOUND: "Numéro introuvable chez l'opérateur.",
  USER_IS_BLOCKED: "Ce compte opérateur est bloqué.",
  FAILED: "Le paiement a échoué.",
  NOT_ALLOWED:
    "CinetPay refuse cette IP. Ajoute-la à la liste blanche dans l’espace marchand → Développeur.",
  CURRENCY_NOT_ALLOWED:
    "Ce compte CinetPay n’accepte pas cette devise. Un compte = un pays : pour le GNF il faut un compte marchand Guinée (GN) en staging, pas Côte d’Ivoire (XOF) ni Cameroun (XAF).",
  NOT_FOUND: "Transaction introuvable.",
  OPERATION_ERROR: "Une erreur est survenue chez CinetPay.",
  SUCCESS: "Opération réussie.",
  OK: "Opération réussie.",
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function maskToken(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `…${value.slice(-4)}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function cinetpayWebhookKey(): string {
  return createHash("sha256").update(env.cinetpaySetupSecret || "missing").digest("hex").slice(0, 16);
}

export function assertCinetPayWebhookKey(provided: string) {
  if (!env.cinetpaySetupSecret || !safeEqual(provided, cinetpayWebhookKey())) {
    throw badRequest("WEBHOOK_SECRET", "Notification CinetPay invalide");
  }
}

export function notifyTokensMatch(expected: string, received: string): boolean {
  if (!expected || !received) return false;
  return safeEqual(expected, received);
}

export function appOrigin(): string {
  return env.corsOrigin.split(",")[0]?.trim().replace(/\/$/, "") || "http://localhost:3000";
}

export function publicApiOrigin(): string {
  if (env.publicApiUrl) return env.publicApiUrl.replace(/\/$/, "");
  return `http://127.0.0.1:${env.port}`;
}

export function cinetpayNotifyUrl(): string {
  return `${publicApiOrigin()}/api/v1/cpn/${cinetpayWebhookKey()}`;
}

export function cinetpayReturnUrls(merchantTransactionId: string) {
  const origin = appOrigin();
  return {
    successUrl: `${origin}/paiement/succes?ref=${merchantTransactionId}`,
    failedUrl: `${origin}/paiement/echec?ref=${merchantTransactionId}`,
  };
}

export function mapCinetPayMessage(status: string, fallback?: string): string {
  return STATUS_MESSAGES[status] || fallback || "Le paiement n'a pas abouti.";
}

export function isFinalSuccess(status: string): boolean {
  return status === "SUCCESS" || status === "OK";
}

export function isFinalFailure(status: string): boolean {
  return (
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "INSUFFICIENT_BALANCE" ||
    status === "OTP_ERROR" ||
    status === "OTP_EXPIRED" ||
    status === "USER_NOT_FOUND" ||
    status === "USER_IS_BLOCKED" ||
    status === "OPERATION_ERROR" ||
    status === "CURRENCY_NOT_ALLOWED" ||
    status === "NOT_ALLOWED"
  );
}

function ensureConfigured() {
  if (!env.cinetpayAccountKey || !env.cinetpayAccountPassword) {
    throw badGateway("CINETPAY_CONFIG", "Paiement CinetPay non configuré.");
  }
}

async function cinetpayFetch(path: string, init: RequestInit & { token?: string } = {}) {
  ensureConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const res = await fetch(`${env.cinetpayBaseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw badGateway("CINETPAY_PARSE", "Réponse CinetPay illisible.");
    }
    return { httpStatus: res.status, json };
  } catch (err) {
    if (err && typeof err === "object" && "statusCode" in err) throw err;
    logger.warn({ path }, "CinetPay network error");
    throw badGateway("CINETPAY_NETWORK", "Impossible de joindre CinetPay. Réessaie.");
  } finally {
    clearTimeout(timer);
  }
}

function parseResult(json: Record<string, unknown>): CinetPayApiResult {
  const details =
    json.details && typeof json.details === "object"
      ? (json.details as Record<string, unknown>)
      : {};
  const status = String(details.status || json.status || "FAILED");
  const code = Number(details.code ?? json.code ?? 0);
  const message = mapCinetPayMessage(
    status,
    String(details.message || json.description || json.message || "")
  );
  const amountRaw = json.amount ?? details.amount;
  const feeRaw = json.fee_amount ?? details.fee_amount;
  return {
    code,
    status,
    message,
    merchantTransactionId: String(
      json.merchant_transaction_id || details.merchant_transaction_id || ""
    ),
    transactionId: String(json.transaction_id || details.transaction_id || ""),
    notifyToken: json.notify_token ? String(json.notify_token) : undefined,
    paymentUrl: json.payment_url ? String(json.payment_url) : undefined,
    paymentToken: json.payment_token ? String(json.payment_token) : undefined,
    mustRedirect: Boolean(details.must_be_redirected),
    amount: amountRaw != null ? Number(amountRaw) : undefined,
    feeAmount: feeRaw != null ? Number(feeRaw) : undefined,
    raw: json,
  };
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return cachedToken.value;
  }
  const { json } = await cinetpayFetch("/v1/oauth/login", {
    method: "POST",
    body: JSON.stringify({
      api_key: env.cinetpayAccountKey,
      api_password: env.cinetpayAccountPassword,
    }),
  });
  const status = String(json.status || "");
  const token = String(json.access_token || "");
  if (!token || (status && status !== "OK")) {
    logger.warn(
      {
        status: json.status,
        code: json.code,
        env: env.cinetpayEnv,
        envSource: env.cinetpayEnvSource,
        host: env.cinetpayBaseUrl,
      },
      "CinetPay login failed"
    );
    if (status === "NOT_ALLOWED") {
      throw badGateway(
        "CINETPAY_AUTH",
        "CinetPay refuse cette IP. Ajoute l’IP publique de ce PC/serveur à la liste blanche dans l’espace marchand → Développeur."
      );
    }
    throw badGateway(
      "CINETPAY_AUTH",
      mapCinetPayMessage(status, "Authentification CinetPay impossible.")
    );
  }
  const expiresIn = Number(json.expires_in || 300);
  cachedToken = {
    value: token,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
  };
  return token;
}

export async function initCinetPayPayment(input: {
  merchantTransactionId: string;
  amountGnf: number;
  method: CinetPayMethod;
  designation: string;
  email: string;
  phoneE164?: string;
  firstName: string;
  lastName: string;
  otpCode?: string;
  notifyUrl: string;
  successUrl: string;
  failedUrl: string;
  directPay: boolean;
}): Promise<CinetPayApiResult> {
  const token = await getAccessToken();
  const body: Record<string, unknown> = {
    currency: env.cinetpayCurrency,
    merchant_transaction_id: input.merchantTransactionId,
    amount: Math.round(input.amountGnf),
    lang: "fr",
    designation: input.designation.slice(0, 255),
    client_email: input.email,
    client_first_name: input.firstName,
    client_last_name: input.lastName,
    success_url: input.successUrl,
    failed_url: input.failedUrl,
    notify_url: input.notifyUrl,
    direct_pay: input.directPay,
  };
  if (input.method !== "CINETPAY") body.payment_method = input.method;
  if (input.phoneE164) body.client_phone_number = input.phoneE164;
  if (input.otpCode) body.otp_code = input.otpCode;

  const { json } = await cinetpayFetch("/v1/payment", {
    method: "POST",
    token,
    body: JSON.stringify(body),
  });
  const result = parseResult(json);
  logger.info(
    {
      merchantTransactionId: input.merchantTransactionId,
      currency: env.cinetpayCurrency,
      status: result.status,
      code: result.code,
      notifyToken: maskToken(result.notifyToken),
    },
    "CinetPay payment init"
  );
  if (result.status === "TRANSACTION_EXIST") {
    return getCinetPayPayment(input.merchantTransactionId);
  }
  return result;
}

export async function getCinetPayPayment(merchantTransactionId: string): Promise<CinetPayApiResult> {
  const token = await getAccessToken();
  const { json } = await cinetpayFetch(`/v1/payment/${encodeURIComponent(merchantTransactionId)}`, {
    method: "GET",
    token,
  });
  return parseResult(json);
}

export async function initCinetPayTransfer(input: {
  merchantTransactionId: string;
  amountGnf: number;
  method: "OM_GN" | "MTN_GN";
  phoneE164: string;
  reason: string;
  notifyUrl: string;
}): Promise<CinetPayApiResult> {
  const token = await getAccessToken();
  const { json } = await cinetpayFetch("/v1/transfer", {
    method: "POST",
    token,
    body: JSON.stringify({
      currency: env.cinetpayCurrency,
      merchant_transaction_id: input.merchantTransactionId,
      amount: Math.round(input.amountGnf),
      payment_method: input.method,
      phone_number: input.phoneE164,
      reason: input.reason.slice(0, 255),
      notify_url: input.notifyUrl,
    }),
  });
  const result = parseResult(json);
  logger.info(
    {
      merchantTransactionId: input.merchantTransactionId,
      status: result.status,
      code: result.code,
    },
    "CinetPay transfer init"
  );
  return result;
}

export async function getCinetPayTransfer(transactionId: string): Promise<CinetPayApiResult> {
  const token = await getAccessToken();
  const { json } = await cinetpayFetch(`/v1/transfer/${encodeURIComponent(transactionId)}`, {
    method: "GET",
    token,
  });
  return parseResult(json);
}

export function throwIfHardFailure(result: CinetPayApiResult): void {
  if (result.status === "OTP_ERROR" || result.status === "OTP_EXPIRED") {
    throw badRequest(result.status, result.message);
  }
  if (
    result.status === "INVALID_PARAMS" ||
    result.status === "USER_NOT_FOUND" ||
    result.status === "CURRENCY_NOT_ALLOWED"
  ) {
    throw badRequest(result.status, result.message);
  }
  if (isFinalFailure(result.status) && result.status !== "PENDING") {
    throw badRequest(result.status, result.message);
  }
}
