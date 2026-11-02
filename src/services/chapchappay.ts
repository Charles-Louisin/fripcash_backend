/**
 * Client Chap Chap Pay (https://chapchappay.com/api — spécification : /api/swagger.json).
 *
 * - Authentification : en-tête `CCP-Api-Key` (la clé test ou production détermine le mode).
 * - Les appels PUSH et les webhooks sont signés par `CCP-HMAC-Signature` :
 *   HMAC-SHA256 (hex) du corps JSON brut, avec la « clé d'encryptage » du tableau de bord.
 * - Aucune clé d'idempotence n'existe côté prestataire : l'unicité repose sur notre `order_id`
 *   (une référence par tentative) et sur la recherche de ce `order_id` dans les transactions du compte.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export type CcpPaymentChannel =
  | "paycard"
  | "orange_money"
  | "mtn_momo"
  | "cc"
  | "kulu"
  | "soutra_money"
  | "akiba";

/** Statuts E-Commerce : `success` est définitif ; `canceled` peut être suivi d'un `success` tardif. */
export type CcpEcommerceStatus = "new" | "pending" | "success" | "canceled" | "failed" | "error" | "expired";
/** Statuts PUSH : `success` est définitif ; `error` peut être suivi d'un `success` tardif. */
export type CcpPushStatus = "initiating" | "pending" | "success" | "error";

export type CcpEcommerceOperation = {
  operation_id: string;
  order_id?: string;
  amount: number;
  amount_formatted?: string;
  payment_url: string;
  fee_handling_mode?: "add" | "deduct";
  status?: { code: CcpEcommerceStatus; description?: string; payment_method?: string };
  transaction?: {
    payment_method?: string;
    payment_method_reference?: string;
    payer_info?: string;
    payment_reference?: string;
    transaction_date?: string;
  };
};

export type CcpPushRequest = {
  request_id: string;
  is_test?: boolean;
  status: CcpPushStatus;
  status_message?: string;
  request_data?: { account_number?: string; amount?: number; payment_channel?: string; order_id?: string };
  payment_transaction?: { payment_reference?: string; payment_method_reference?: string; transaction_date?: string };
  insert_date?: string;
  update_date?: string;
};

export type CcpAccountInfo = {
  info?: { name?: string; is_suspended?: boolean; is_closed?: boolean; is_kyc_verified?: boolean };
  services?: {
    is_ecommerce_enabled?: boolean;
    is_api_push_enabled?: boolean;
    is_api_pull_enabled?: boolean;
  };
  balance?: { amount?: number; currency?: string };
};

export type CcpTransaction = {
  transaction_date?: string;
  payment_reference?: string;
  payment_method?: string;
  amount?: number;
  commission_amount?: number;
  currency?: string;
  is_canceled?: boolean;
  order_id?: string;
};

export type CcpTransactionPage = {
  transactions: CcpTransaction[];
  pager?: { current_page?: number; total_pages?: number; next_page?: number | null };
};

/**
 * - `rejected`   : le prestataire a refusé la requête (4xx) → aucune opération créée.
 * - `unavailable`: la connexion n'a jamais été établie → la requête n'est pas partie.
 * - `unknown`    : la requête a pu être exécutée (timeout, 5xx, réponse illisible) → à vérifier.
 */
export type CcpErrorKind = "rejected" | "unavailable" | "unknown" | "config";

export class ChapChapPayError extends Error {
  constructor(
    public kind: CcpErrorKind,
    message: string,
    public httpStatus?: number,
    public body?: unknown
  ) {
    super(message);
    this.name = "ChapChapPayError";
  }
}

/** Interface injectée dans les services : permet des tests sans réseau. */
export interface PaymentProviderClient {
  createEcommerceOperation(input: {
    orderId: string;
    amountGnf: number;
    description: string;
    callbackUrl: string;
    returnUrl: string;
    cancelUrl: string;
    jumpTo?: CcpPaymentChannel;
    customer?: { firstname?: string; lastname?: string; email?: string; tel?: string };
  }): Promise<CcpEcommerceOperation>;
  getEcommerceOperation(operationId: string): Promise<CcpEcommerceOperation>;
  findEcommerceOperationByOrderId(orderId: string): Promise<CcpEcommerceOperation | null>;
  pushRequest(input: {
    orderId: string;
    amountGnf: number;
    channel: "orange_money" | "mtn_momo" | "paycard";
    accountNumber: string;
    accountName?: string;
    callbackUrl: string;
  }): Promise<CcpPushRequest>;
  getPushRequest(requestId: string): Promise<CcpPushRequest | null>;
  getAccountInfo(): Promise<CcpAccountInfo>;
  listTransactions(page: number): Promise<CcpTransactionPage>;
}

// Erreurs survenues avant l'envoi de la requête : le prestataire n'a rien reçu.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export function signCcpPayload(rawBody: string | Buffer, key = env.chapchapEncryptionKey): string {
  return createHmac("sha256", key).update(rawBody).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a.trim().toLowerCase());
  const right = Buffer.from(b.trim().toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Vérifie un webhook Chap Chap Pay : signature HMAC sur le corps BRUT et clé API renvoyée.
 * Un webhook valide reste une simple alerte : son contenu est toujours revérifié par l'API.
 */
export function verifyCcpWebhook(rawBody: Buffer, signature: string | undefined, apiKey: string | undefined) {
  if (!env.chapchapEncryptionKey || !env.chapchapApiKey) return false;
  if (!signature || !apiKey) return false;
  if (!safeEqualHex(signCcpPayload(rawBody), signature)) return false;
  const a = Buffer.from(apiKey);
  const b = Buffer.from(env.chapchapApiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ensureConfigured(needsPush = false) {
  if (!env.chapchapApiKey) throw new ChapChapPayError("config", "Chap Chap Pay n'est pas configuré (CHAPCHAPPAY_API_KEY).");
  if (needsPush && (!env.chapchapEncryptionKey || !env.chapchapPushAccessCode)) {
    throw new ChapChapPayError(
      "config",
      "Reversements Chap Chap Pay non configurés (CHAPCHAPPAY_ENCRYPTION_KEY, CHAPCHAPPAY_PUSH_ACCESS_CODE)."
    );
  }
}

async function ccpFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown>; signed?: boolean }
): Promise<{ status: number; json: any }> {
  const raw = init.body ? JSON.stringify(init.body) : undefined;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "CCP-Api-Key": env.chapchapApiKey,
  };
  if (raw) headers["Content-Type"] = "application/json";
  if (raw && init.signed) headers["CCP-HMAC-Signature"] = signCcpPayload(raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.chapchapTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.chapchapBaseUrl}${path}`, {
      method: init.method,
      headers,
      body: raw,
      signal: controller.signal,
    });
  } catch (err: any) {
    const code = String(err?.cause?.code || err?.code || "");
    if (NOT_SENT_CODES.has(code)) {
      throw new ChapChapPayError("unavailable", `Chap Chap Pay injoignable (${code}).`);
    }
    // Abandon, coupure en cours d'échange… : la requête a pu être traitée.
    throw new ChapChapPayError("unknown", `Réponse Chap Chap Pay non reçue (${code || err?.name || "timeout"}).`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status >= 500) {
    throw new ChapChapPayError("unknown", `Erreur Chap Chap Pay ${res.status}.`, res.status, json ?? text.slice(0, 500));
  }
  return { status: res.status, json };
}

function rejection(status: number, json: any, fallback: string) {
  const detail = json?.message || json?.error || fallback;
  const fields = json?.errors ? ` ${JSON.stringify(json.errors).slice(0, 300)}` : "";
  return new ChapChapPayError("rejected", `${detail}${fields}`, status, json);
}

export const chapChapPayClient: PaymentProviderClient = {
  async createEcommerceOperation(input) {
    ensureConfigured();
    const options: Record<string, unknown> = { "auto-redirect": true };
    if (input.jumpTo) options["jump-to-payment-method"] = input.jumpTo;
    if (input.customer && Object.values(input.customer).some(Boolean)) {
      options.customer = { ...input.customer, allow_edit: true };
    }
    const body = {
      amount: Math.round(input.amountGnf),
      order_id: input.orderId,
      description: input.description.slice(0, 255),
      fee_handling: env.chapchapFeeHandling,
      callback_url: input.callbackUrl,
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
      options,
    };
    const { status, json } = await ccpFetch("/ecommerce/create", { method: "POST", body, signed: true });
    if (status !== 201 && status !== 200) throw rejection(status, json, "Création du lien de paiement refusée.");
    if (!json?.operation_id || !json?.payment_url) {
      throw new ChapChapPayError("unknown", "Réponse Chap Chap Pay incomplète.", status, json);
    }
    logger.info({ orderId: input.orderId, operationId: json.operation_id }, "ChapChapPay ecommerce created");
    return json as CcpEcommerceOperation;
  },

  async getEcommerceOperation(operationId) {
    ensureConfigured();
    const { status, json } = await ccpFetch(`/ecommerce/${encodeURIComponent(operationId)}`, { method: "GET" });
    if (status !== 200) throw rejection(status, json, "Opération introuvable.");
    return json as CcpEcommerceOperation;
  },

  async findEcommerceOperationByOrderId(orderId) {
    ensureConfigured();
    const { status, json } = await ccpFetch(`/ecommerce/order/${encodeURIComponent(orderId)}`, { method: "GET" });
    if (status === 404) return null;
    if (status !== 200) throw rejection(status, json, "Recherche de l'opération impossible.");
    return json as CcpEcommerceOperation;
  },

  async pushRequest(input) {
    ensureConfigured(true);
    const body = {
      account_number: input.accountNumber,
      account_name: input.accountName || undefined,
      payment_channel: input.channel,
      amount: Math.round(input.amountGnf),
      order_id: input.orderId,
      fee_handling: "deduct",
      callback_url: input.callbackUrl,
    };
    const { status, json } = await ccpFetch(
      `/push/${encodeURIComponent(env.chapchapPushAccessCode)}/request`,
      { method: "POST", body, signed: true }
    );
    if (status >= 400) throw rejection(status, json, "Transfert refusé par Chap Chap Pay.");
    if (!json?.request_id || !json?.status) {
      throw new ChapChapPayError("unknown", "Réponse de transfert incomplète.", status, json);
    }
    return json as CcpPushRequest;
  },

  async getPushRequest(requestId) {
    ensureConfigured(true);
    const { status, json } = await ccpFetch(
      `/push/${encodeURIComponent(env.chapchapPushAccessCode)}/request/${encodeURIComponent(requestId)}`,
      { method: "GET" }
    );
    if (status === 404) return null;
    if (status !== 200) throw rejection(status, json, "Statut du transfert indisponible.");
    return json as CcpPushRequest;
  },

  async getAccountInfo() {
    ensureConfigured();
    const { status, json } = await ccpFetch("/account/info", { method: "GET" });
    if (status !== 200) throw rejection(status, json, "Informations du compte indisponibles.");
    return json as CcpAccountInfo;
  },

  async listTransactions(page) {
    ensureConfigured();
    const { status, json } = await ccpFetch(`/account/transaction?page=${Math.max(1, page)}`, { method: "GET" });
    if (status !== 200) throw rejection(status, json, "Transactions du compte indisponibles.");
    return { transactions: json?.transactions || [], pager: json?.pager } as CcpTransactionPage;
  },
};

let activeClient: PaymentProviderClient = chapChapPayClient;

export function paymentProvider(): PaymentProviderClient {
  return activeClient;
}

/** Tests uniquement : remplace le client réseau par un double. */
export function setPaymentProviderForTests(client: PaymentProviderClient | null) {
  activeClient = client || chapChapPayClient;
}

export function ccpChannelForOperator(operator: "OM_GN" | "MTN_GN"): "orange_money" | "mtn_momo" {
  return operator === "OM_GN" ? "orange_money" : "mtn_momo";
}
