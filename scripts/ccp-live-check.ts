/**
 * Vérification réelle de la connexion Chap Chap Pay (clé de TEST conseillée) :
 *   npm run ccp:check
 * Crée un lien de paiement de test et relit son statut. N'envoie aucun reversement.
 */
import { chapChapPayClient as ccp } from "../src/services/chapchappay.js";
import { env } from "../src/config/env.js";

async function step(label: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    console.log(`✔ ${label}`, JSON.stringify(out, null, 1).slice(0, 900));
    return out as any;
  } catch (err: any) {
    console.log(`✖ ${label}`, err?.kind || "", err?.httpStatus || "", err?.message, JSON.stringify(err?.body || "").slice(0, 400));
    return null;
  }
}

const orderId = `FC-CHECK-${Date.now()}`;
const info = await step("Compte (/account/info)", () => ccp.getAccountInfo());
const op = await step("Lien de paiement (/ecommerce/create)", () =>
  ccp.createEcommerceOperation({
    orderId,
    amountGnf: Math.max(env.chapchapMinPaymentGnf, 5000),
    description: "Test connexion FripCash",
    callbackUrl: `${env.publicApiUrl}/api/v1/payments/webhook/chapchappay`,
    returnUrl: `${env.publicApiUrl}/api/v1/payments/return/${orderId}`,
    cancelUrl: `${env.publicApiUrl}/api/v1/payments/return/${orderId}?cancel=1`,
  })
);
if (op) {
  await step("Statut par operation_id", () => ccp.getEcommerceOperation(op.operation_id));
  await step("Statut par order_id", () => ccp.findEcommerceOperationByOrderId(orderId));
}
await step("Transactions (/account/transaction)", async () => {
  const r = await ccp.listTransactions(1);
  return { count: r.transactions.length, pager: r.pager, first: r.transactions[0] };
});
console.log("PUSH configuré :", Boolean(env.chapchapPushAccessCode), "| services :", JSON.stringify(info?.services || {}));
