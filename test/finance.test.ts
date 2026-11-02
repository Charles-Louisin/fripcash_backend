/**
 * Scénarios obligatoires (paiement.md §19) : MongoDB réel en replica set (transactions)
 * et double du prestataire Chap Chap Pay, sans aucun appel réseau.
 *
 *   npm test
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
process.env.CHAPCHAPPAY_API_KEY = "a".repeat(64);
process.env.CHAPCHAPPAY_ENCRYPTION_KEY = "test-encryption-key";
process.env.CHAPCHAPPAY_PUSH_ACCESS_CODE = "111222";
process.env.CHAPCHAPPAY_MIN_PAYMENT_GNF = "1000";
process.env.CHAPCHAPPAY_MIN_PAYOUT_GNF = "500";
process.env.FINANCE_WORKER_ENABLED = "false";
process.env.FINANCE_REQUIRE_TRANSACTIONS = "true";
process.env.PAYOUT_AUTO_EXECUTE = "true";
process.env.PUBLIC_API_URL = "https://api.fripcash.test";
process.env.OTP_DEV_ECHO = "false";

const { MongoMemoryReplSet } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const { User } = await import("../src/models/user.js");
const { Order, Payment } = await import("../src/models/commerce.js");
const { Dispute } = await import("../src/models/ops.js");
const F = await import("../src/models/finance.js");
const { ChapChapPayError, setPaymentProviderForTests } = await import("../src/services/chapchappay.js");
const { startChapChapCheckout, verifyChapChapPayment } = await import("../src/services/finance/payment-service.js");
const { calculateFinancialBreakdown } = await import("../src/services/finance/financial-service.js");
const delivery = await import("../src/services/finance/delivery-service.js");
const payouts = await import("../src/services/finance/payout-service.js");
const { drainOutbox } = await import("../src/services/finance/worker.js");
const { detectDuplicateOperations } = await import("../src/services/finance/reconciliation-service.js");
const { createApp } = await import("../src/app.js");

type PushBehavior = "success" | "error" | "pending" | "timeout" | "timeout_executed";

/** Double fidèle du contrat Chap Chap Pay (statuts, order_id, transactions du compte). */
class FakeChapChapPay {
  ops = new Map<string, any>();
  pushes = new Map<string, any>();
  pushCalls: any[] = [];
  balance = 10_000_000;
  behavior: (input: any) => PushBehavior = () => "success";

  async createEcommerceOperation(input: any) {
    const id = randomUUID();
    const op = {
      operation_id: id,
      order_id: input.orderId,
      amount: input.amountGnf,
      amount_formatted: `${input.amountGnf} GNF`,
      payment_url: `https://chapchappay.com/pay/${id}`,
      status: { code: "new" },
    };
    this.ops.set(id, op);
    return op;
  }
  async getEcommerceOperation(id: string) {
    const op = this.ops.get(id);
    if (!op) throw new ChapChapPayError("rejected", "Not found", 404);
    return op;
  }
  async findEcommerceOperationByOrderId(orderId: string) {
    return [...this.ops.values()].find((o) => o.order_id === orderId) || null;
  }
  setPaymentStatus(orderId: string, code: string) {
    const op = [...this.ops.values()].find((o) => o.order_id === orderId);
    op.status = { code };
    if (code === "success") op.transaction = { payment_method: "orange_money", payment_reference: `ECOM-${orderId}` };
    return op;
  }
  async pushRequest(input: any) {
    this.pushCalls.push(input);
    const mode = this.behavior(input);
    const request_id = randomUUID();
    if (mode === "timeout") throw new ChapChapPayError("unknown", "timeout");
    const status = mode === "timeout_executed" ? "success" : mode;
    this.pushes.set(request_id, { request_id, status, request_data: { order_id: input.orderId, amount: input.amountGnf, account_number: input.accountNumber } });
    if (status === "success") this.balance -= input.amountGnf;
    if (mode === "timeout_executed") throw new ChapChapPayError("unknown", "timeout after execution");
    return { request_id, status, status_message: status === "error" ? "Numéro invalide" : "" };
  }
  async getPushRequest(id: string) {
    return this.pushes.get(id) || null;
  }
  async getAccountInfo() {
    return { services: { is_api_push_enabled: true }, balance: { amount: this.balance, currency: "GNF" } };
  }
  async listTransactions(_page: number) {
    const debits = [...this.pushes.values()]
      .filter((p) => p.status === "success")
      .map((p) => ({ order_id: p.request_data.order_id, amount: -p.request_data.amount, is_canceled: false, payment_reference: `PUSH-${p.request_id}` }));
    return { transactions: debits, pager: { current_page: 1, total_pages: 1 } };
  }
}

let replSet: InstanceType<typeof MongoMemoryReplSet>;
let fake: FakeChapChapPay;
let phoneSeq = 100000;

function gnPhone() {
  phoneSeq += 1;
  return `+22462${String(phoneSeq).padStart(7, "0")}`;
}

async function user(kind: "buyer" | "seller" | "courier", name: string) {
  const phone = gnPhone();
  return User.create({
    name,
    phone,
    email: `${randomUUID()}@fripcash.test`,
    authAudience: kind === "courier" ? "COURIER" : "CONSUMER",
    seller: kind === "seller" ? { kind: "boutique", shopName: name, orangeMoneyPhone: phone, verificationStatus: "approved" } : null,
    courier: kind === "courier" ? { verificationStatus: "approved", isAvailable: true } : null,
  });
}

function sellerOrder(buyer: any, seller: any, gross: number, net: number, shipping = 0) {
  return Order.create({
    buyerId: buyer._id,
    sellerId: seller._id,
    items: [{ title: `Article ${seller.name}`, quantity: 1, priceGnf: gross, netPriceGnf: net, commissionGnf: gross - net }],
    amountGnf: gross,
    commissionGnf: gross - net,
    shippingCostGnf: shipping,
    status: "ORDERED",
    escrowStatus: "pending",
    fulfillmentMode: shipping > 0 ? "courier" : "pickup",
    address: { name: buyer.name, phone: buyer.phone, paymentPhone: buyer.phone },
  });
}

/** Panier de référence de la spécification : 3 vendeurs + 1 livreur, 115 000 GNF. */
async function paidMarketplaceOrder() {
  const buyer = await user("buyer", "Client 001");
  const [a, b, c] = await Promise.all([user("seller", "Vendeur A"), user("seller", "Vendeur B"), user("seller", "Vendeur C")]);
  const courier = await user("courier", "Livreur 001");
  const orders = [
    await sellerOrder(buyer, a, 50_000, 45_000, 5_000),
    await sellerOrder(buyer, b, 35_000, 30_000),
    await sellerOrder(buyer, c, 25_000, 20_000),
  ];
  const payment = await startChapChapCheckout({
    orders,
    buyerId: buyer._id,
    method: "OM_GN",
    payPhone: { e164: buyer.phone!, local: buyer.phone!.slice(4) },
    name: buyer.name,
    email: buyer.email!,
    reservedLines: [],
  });
  fake.setPaymentStatus(payment!.merchantTransactionId, "success");
  await verifyChapChapPayment(payment!._id, { force: true });
  await delivery.assignCourier(orders[0]!._id, courier._id);
  return { buyer, sellers: { a, b, c }, courier, orders, payment: (await Payment.findById(payment!._id))! };
}

async function receive(order: any, buyer: any) {
  await Order.updateOne({ _id: order._id }, { $set: { status: "DELIVERED", buyerConfirmedAt: new Date() } });
  return delivery.confirmSellerOrderReceipt(order._id, { userId: String(buyer._id), role: "buyer" });
}

async function payoutOf(sellerOrderId: unknown) {
  return F.Payout.findOne({ sellerOrderId, beneficiaryType: "seller" });
}

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("fripcash_test"));
});

after(async () => {
  setPaymentProviderForTests(null);
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
  fake = new FakeChapChapPay();
  setPaymentProviderForTests(fake as any);
});

describe("Décomposition financière", () => {
  test("exemple de la spécification : 115 000 GNF entièrement alloués", () => {
    const b = calculateFinancialBreakdown([
      { _id: "A", sellerId: "sA", amountGnf: 50_000, shippingCostGnf: 5_000, fulfillmentMode: "courier", items: [{ priceGnf: 50_000, netPriceGnf: 45_000, quantity: 1 }] },
      { _id: "B", sellerId: "sB", amountGnf: 35_000, items: [{ priceGnf: 35_000, netPriceGnf: 30_000, quantity: 1 }] },
      { _id: "C", sellerId: "sC", amountGnf: 25_000, items: [{ priceGnf: 25_000, netPriceGnf: 20_000, quantity: 1 }] },
    ]);
    assert.equal(b.totalPaid, 115_000);
    assert.deepEqual(b.sellers.map((s) => s.sellerPayable), [45_000, 30_000, 20_000]);
    assert.equal(b.courierTotal, 5_000);
    assert.equal(b.platformCommission, 15_000);
    assert.equal(b.totalAllocated, b.totalPaid);
  });
});

describe("Scénarios obligatoires", () => {
  test("1 — paiement réussi : un paiement, trois sous-commandes, allocations exactes", async () => {
    const { payment, orders } = await paidMarketplaceOrder();
    assert.equal(payment.status, "success");
    assert.equal(await Payment.countDocuments({ kind: "payment" }), 1);
    const parent = await F.ParentOrder.findById(payment.parentOrderId);
    assert.equal(parent!.payment!.status, "paid");
    assert.equal(parent!.sellerOrderIds.length, 3);
    const allocs = await F.FinancialAllocation.find({ parentOrderId: parent!._id });
    assert.equal(allocs.length, 5);
    assert.ok(allocs.every((a) => a.status === "funded"));
    const by = (t: string) => allocs.filter((a) => a.beneficiaryType === t).map((a) => a.amount).sort((x, y) => x - y);
    assert.deepEqual(by("seller"), [20_000, 30_000, 45_000]);
    assert.deepEqual(by("courier"), [5_000]);
    assert.deepEqual(by("platform"), [15_000]);
    assert.equal(allocs.reduce((s, a) => s + a.amount, 0), 115_000);
    for (const o of orders) assert.equal((await Order.findById(o._id))!.status, "SELLER_NOTIFIED");
    assert.equal(await F.Payout.countDocuments(), 0, "aucun vendeur payé au simple paiement");
  });

  test("2 — le vendeur A reçoit son colis avant les autres : seul A est payé", async () => {
    const { orders, buyer } = await paidMarketplaceOrder();
    await receive(orders[0], buyer);
    await drainOutbox("w1");
    assert.equal((await payoutOf(orders[0]!._id))!.status, "succeeded");
    assert.equal(await payoutOf(orders[1]!._id), null);
    assert.equal(await payoutOf(orders[2]!._id), null);
    const b = await F.FinancialAllocation.findOne({ sellerOrderId: orders[1]!._id, beneficiaryType: "seller" });
    assert.equal(b!.status, "funded");
    assert.equal(fake.pushCalls.length, 1);
  });

  test("3 & 4 — C échoue, A/B/livreur restent payés ; seule la relance de C repart", async () => {
    const { orders, buyer, sellers } = await paidMarketplaceOrder();
    const cAccount = sellers.c.phone!.slice(4);
    fake.behavior = (input) => (input.accountNumber === cAccount ? "error" : "success");
    for (const o of orders) await receive(o, buyer);
    const order = await Order.findById(orders[0]!._id);
    await delivery.confirmDelivery(order!.deliveryId, { method: "buyer_confirmation", by: String(buyer._id) });
    await drainOutbox("w1");

    const statuses = await F.Payout.find().sort({ payoutReference: 1 });
    assert.equal(statuses.length, 4);
    assert.equal((await payoutOf(orders[0]!._id))!.status, "succeeded");
    assert.equal((await payoutOf(orders[1]!._id))!.status, "succeeded");
    assert.equal((await payoutOf(orders[2]!._id))!.status, "failed");
    assert.equal((await F.Payout.findOne({ beneficiaryType: "courier" }))!.status, "succeeded");
    const callsBefore = fake.pushCalls.length;

    // Relance refusée pour un Payout réussi.
    await assert.rejects(payouts.retryFailedPayout(String((await payoutOf(orders[0]!._id))!._id), { actorId: String(buyer._id) }), /échec/);

    const c = (await payoutOf(orders[2]!._id))!;
    await F.Payout.updateOne({ _id: c._id }, { $set: { lastAttemptAt: new Date(Date.now() - 3_600_000) } });
    fake.behavior = () => "success";
    await payouts.retryFailedPayout(String(c._id), { actorId: String(buyer._id) });
    await drainOutbox("w1");

    assert.equal(fake.pushCalls.length, callsBefore + 1, "un seul nouvel envoi, uniquement pour C");
    assert.equal(fake.pushCalls.at(-1).accountNumber, cAccount);
    const attempts = await F.PayoutAttempt.find({ payoutId: c._id }).sort({ attemptNumber: 1 });
    assert.deepEqual(attempts.map((a) => a.status), ["failed", "succeeded"]);
    assert.equal((await F.Payout.findById(c._id))!.status, "succeeded");
    assert.equal(await F.PayoutAttempt.countDocuments({ status: "succeeded" }), 4);
    assert.equal((await Order.findById(orders[2]!._id))!.status, "FUNDS_RELEASED");
  });

  test("5 — webhook reçu deux fois : une seule confirmation, une seule série d'allocations", async () => {
    const buyer = await user("buyer", "Client");
    const seller = await user("seller", "Vendeur");
    const order = await sellerOrder(buyer, seller, 20_000, 18_000);
    const payment = (await startChapChapCheckout({
      orders: [order],
      buyerId: buyer._id,
      method: "CHAPCHAPPAY",
      payPhone: { e164: buyer.phone!, local: buyer.phone!.slice(4) },
      name: buyer.name,
      email: buyer.email!,
      reservedLines: [],
    }))!;
    const op = fake.setPaymentStatus(payment.merchantTransactionId, "success");
    const server = createApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const body = JSON.stringify({ order_id: op.order_id, operation_id: op.operation_id, amount: op.amount, status: { code: "success" } });
      const send = (signature: string) =>
        fetch(`http://127.0.0.1:${port}/api/v1/payments/webhook/chapchappay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "CCP-Api-Key": process.env.CHAPCHAPPAY_API_KEY!, "CCP-HMAC-Signature": signature },
          body,
        });
      const good = createHmac("sha256", process.env.CHAPCHAPPAY_ENCRYPTION_KEY!).update(body).digest("hex");
      assert.equal((await send("deadbeef")).status, 401, "signature invalide refusée");
      assert.equal((await send(good)).status, 200);
      assert.equal((await send(good)).status, 200);
    } finally {
      server.close();
    }
    await drainOutbox("w1");
    await verifyChapChapPayment(payment._id, { force: true });
    assert.equal((await Payment.findById(payment._id))!.status, "success");
    assert.equal(await F.FinancialLedgerEntry.countDocuments({ type: "payment_confirmed" }), 1);
    assert.equal(await F.FinancialAllocation.countDocuments(), 2);
    const event = await F.PaymentWebhookEvent.findOne();
    assert.equal(event!.duplicates, 1);
    assert.equal((await Order.findById(order._id))!.timeline.filter((t: any) => t.status === "PAID").length, 1);
  });

  test("6 — timeout du prestataire : statut inconnu, vérification, jamais de renvoi", async () => {
    const { orders, buyer } = await paidMarketplaceOrder();
    fake.behavior = () => "timeout_executed";
    await receive(orders[1], buyer);
    await drainOutbox("w1", 1);
    const p = (await payoutOf(orders[1]!._id))!;
    assert.equal(p.status, "unknown");
    // Vérification : le transfert est retrouvé dans les transactions du compte via notre order_id.
    await payouts.verifyPayout(String(p._id));
    assert.equal((await F.Payout.findById(p._id))!.status, "succeeded");
    assert.equal(fake.pushCalls.length, 1);

    // Timeout sans exécution : reste inconnu, aucune nouvelle requête envoyée.
    fake.behavior = () => "timeout";
    await receive(orders[2], buyer);
    await drainOutbox("w1", 1);
    const q = (await payoutOf(orders[2]!._id))!;
    for (let i = 0; i < 3; i++) await payouts.verifyPayout(String(q._id));
    assert.equal((await F.Payout.findById(q._id))!.status, "unknown");
    await assert.rejects(payouts.retryFailedPayout(String(q._id), { actorId: "x" }), /échec/);
    assert.equal(fake.pushCalls.length, 2);
  });

  test("7 — deux workers simultanés : un seul obtient le verrou", async () => {
    const { orders, buyer } = await paidMarketplaceOrder();
    await receive(orders[1], buyer);
    const p = (await payoutOf(orders[1]!._id))!;
    await Promise.all([payouts.executePayout(String(p._id), "w1"), payouts.executePayout(String(p._id), "w2"), drainOutbox("w3")]);
    assert.equal(fake.pushCalls.length, 1);
    assert.equal(await F.PayoutAttempt.countDocuments({ payoutId: p._id }), 1);
    assert.equal((await F.Payout.findById(p._id))!.status, "succeeded");
  });

  test("8 — lot partiellement exécuté : chaque Payout garde son statut", async () => {
    const { orders, buyer, sellers } = await paidMarketplaceOrder();
    for (const o of orders) await receive(o, buyer);
    const order = await Order.findById(orders[0]!._id);
    await delivery.confirmDelivery(order!.deliveryId, { method: "buyer_confirmation", by: String(buyer._id) });
    // Mode manuel : les Payouts attendent l'admin.
    await F.Payout.updateMany({}, { $set: { status: "eligible" } });
    await F.OutboxEvent.deleteMany({});
    const cAccount = sellers.c.phone!.slice(4);
    fake.behavior = (input) => (input.accountNumber === cAccount ? "error" : "success");
    const batch = await payouts.executePayoutBatch({ actorId: String(buyer._id) });
    await drainOutbox("w1");
    await payouts.refreshPayoutBatch(String(batch._id));
    const fresh = (await F.PayoutBatch.findById(batch._id))!;
    assert.equal(fresh.status, "partially_completed");
    assert.equal(fresh.results.filter((r: any) => r.status === "succeeded").length, 3);
    assert.equal(fresh.results.filter((r: any) => r.status === "failed").length, 1);
    assert.equal(fake.pushCalls.length, 4);
  });

  test("9 — deux livraisons séparées : chaque prestation payée une seule fois", async () => {
    const buyer = await user("buyer", "Client");
    const [a, b] = await Promise.all([user("seller", "A"), user("seller", "B")]);
    const [c1, c2] = await Promise.all([user("courier", "L1"), user("courier", "L2")]);
    const orders = [await sellerOrder(buyer, a, 30_000, 27_000, 4_000), await sellerOrder(buyer, b, 20_000, 18_000, 3_000)];
    const payment = (await startChapChapCheckout({ orders, buyerId: buyer._id, method: "OM_GN", payPhone: { e164: buyer.phone!, local: buyer.phone!.slice(4) }, name: "Client", email: buyer.email!, reservedLines: [] }))!;
    fake.setPaymentStatus(payment.merchantTransactionId, "success");
    await verifyChapChapPayment(payment._id, { force: true });
    await delivery.assignCourier(orders[0]!._id, c1._id);
    await delivery.assignCourier(orders[1]!._id, c2._id);

    await receive(orders[0], buyer);
    const o1 = (await Order.findById(orders[0]!._id))!;
    await delivery.confirmDelivery(o1.deliveryId, { method: "buyer_confirmation", by: String(buyer._id) });
    await delivery.confirmDelivery(o1.deliveryId, { method: "buyer_confirmation", by: String(buyer._id) });
    await drainOutbox("w1");
    assert.equal(await F.Payout.countDocuments({ beneficiaryType: "courier" }), 1);
    assert.equal(await payoutOf(orders[1]!._id), null, "B attend son propre colis");

    await assert.rejects(delivery.confirmDelivery((await Order.findById(orders[1]!._id))!.deliveryId, { method: "buyer_confirmation", by: String(c2._id) }), /propre livraison/);
    await receive(orders[1], buyer);
    await delivery.confirmDelivery((await Order.findById(orders[1]!._id))!.deliveryId, { method: "buyer_confirmation", by: String(buyer._id) });
    await drainOutbox("w1");
    const courierPayouts = await F.Payout.find({ beneficiaryType: "courier" });
    assert.deepEqual(courierPayouts.map((p) => p.amount).sort(), [3_000, 4_000]);
    assert.ok(courierPayouts.every((p) => p.status === "succeeded"));
    assert.equal(fake.pushCalls.length, 4);
  });

  test("10 — litige sur B : seul B est bloqué", async () => {
    const { orders, buyer } = await paidMarketplaceOrder();
    const dispute = await Dispute.create({ orderId: orders[1]!._id, openedBy: buyer._id, openerRole: "buyer", reason: "Article abîmé" });
    await delivery.holdForDispute(orders[1]!._id, dispute._id, "Article abîmé");
    const out = await receive(orders[1], buyer);
    assert.equal(out.eligible, false);
    await receive(orders[0], buyer);
    await receive(orders[2], buyer);
    await drainOutbox("w1");
    assert.equal((await payoutOf(orders[0]!._id))!.status, "succeeded");
    assert.equal((await payoutOf(orders[2]!._id))!.status, "succeeded");
    assert.equal(await payoutOf(orders[1]!._id), null);
    const b = await F.FinancialAllocation.findOne({ sellerOrderId: orders[1]!._id, beneficiaryType: "seller" });
    assert.equal(b!.hold!.active, true);

    // Décision : le vendeur est payé, sans toucher aux autres.
    await delivery.resolveFinancialDispute(await Order.findById(orders[1]!._id), "release_seller", { buyerPercent: 0, actorId: String(buyer._id), disputeId: dispute._id });
    await drainOutbox("w1");
    assert.equal((await payoutOf(orders[1]!._id))!.status, "succeeded");
    assert.equal(fake.pushCalls.length, 3);
  });

  test("11 — remboursement d'une sous-commande : traçable, sans effacer l'historique", async () => {
    const { orders, buyer, payment } = await paidMarketplaceOrder();
    const ledgerBefore = await F.FinancialLedgerEntry.countDocuments({ type: "allocation_created" });
    const refund = await delivery.refundSellerOrder(orders[2]!._id, "Le vendeur annule", String(buyer._id));
    assert.equal(refund!.amount, 25_000, "net vendeur + commission de C");
    await drainOutbox("w1");
    assert.equal((await F.Refund.findById(refund!._id))!.status, "succeeded");
    const buyerPayout = await F.Payout.findOne({ beneficiaryType: "buyer" });
    assert.equal(buyerPayout!.status, "succeeded");
    assert.equal(buyerPayout!.destination!.phoneNumber, buyer.phone);
    const c = await F.FinancialAllocation.findOne({ sellerOrderId: orders[2]!._id, beneficiaryType: "seller" });
    assert.equal(c!.status, "refunded");
    assert.equal(c!.amount, 20_000, "montant initial conservé");
    const platform = await F.FinancialAllocation.findOne({ beneficiaryType: "platform" });
    assert.equal(platform!.refundedAmount, 5_000);
    assert.equal(await F.FinancialLedgerEntry.countDocuments({ type: "allocation_created" }), ledgerBefore);
    assert.equal((await Payment.findById(payment._id))!.status, "partially_refunded");
    // Le ledger est immuable.
    await assert.rejects(F.FinancialLedgerEntry.updateOne({}, { $set: { amount: 1 } }), /immuable/);
    // C n'est plus jamais payé, mais le remboursement de C ne bloque pas A.
    await receive(orders[2], buyer);
    await receive(orders[0], buyer);
    await drainOutbox("w1");
    assert.equal(await payoutOf(orders[2]!._id), null);
    assert.equal((await payoutOf(orders[0]!._id))!.status, "succeeded");
  });

  test("tentative échouée (numéro introuvable) : le client peut réessayer, clôture après 30 min", async () => {
    const buyer = await user("buyer", "Client");
    const seller = await user("seller", "Vendeur");
    const order = await sellerOrder(buyer, seller, 20_000, 18_000);
    const payment = (await startChapChapCheckout({ orders: [order], buyerId: buyer._id, method: "OM_GN", payPhone: { e164: buyer.phone!, local: buyer.phone!.slice(4) }, name: "Client", email: buyer.email!, reservedLines: [] }))!;
    fake.setPaymentStatus(payment.merchantTransactionId, "error");
    await verifyChapChapPayment(payment._id, { force: true });
    assert.equal((await Payment.findById(payment._id))!.status, "pending", "commande gardée pendant la fenêtre de nouvel essai");
    assert.equal((await Order.findById(order._id))!.status, "ORDERED");

    // Le client réessaie avec le bon numéro : paiement confirmé normalement.
    fake.setPaymentStatus(payment.merchantTransactionId, "success");
    await verifyChapChapPayment(payment._id, { force: true });
    assert.equal((await Payment.findById(payment._id))!.status, "success");

    // Sans nouvel essai réussi, la commande est close après la fenêtre.
    const order2 = await sellerOrder(buyer, seller, 15_000, 13_500);
    const p2 = (await startChapChapCheckout({ orders: [order2], buyerId: buyer._id, method: "OM_GN", payPhone: { e164: buyer.phone!, local: buyer.phone!.slice(4) }, name: "Client", email: buyer.email!, reservedLines: [] }))!;
    fake.setPaymentStatus(p2.merchantTransactionId, "error");
    await Payment.collection.updateOne({ _id: p2._id }, { $set: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    await verifyChapChapPayment(p2._id, { force: true });
    assert.equal((await Payment.findById(p2._id))!.status, "failed");
    assert.equal((await Order.findById(order2._id))!.status, "REFUNDED");
  });

  test("annulation puis succès tardif de l'opérateur : remboursement automatique, aucun vendeur payé", async () => {
    const buyer = await user("buyer", "Client");
    const seller = await user("seller", "Vendeur");
    const order = await sellerOrder(buyer, seller, 20_000, 18_000);
    const payment = (await startChapChapCheckout({ orders: [order], buyerId: buyer._id, method: "MTN_GN", payPhone: { e164: buyer.phone!, local: buyer.phone!.slice(4) }, name: "Client", email: buyer.email!, reservedLines: [] }))!;
    fake.setPaymentStatus(payment.merchantTransactionId, "canceled");
    await verifyChapChapPayment(payment._id, { force: true });
    assert.equal((await Payment.findById(payment._id))!.status, "canceled");
    assert.equal((await Order.findById(order._id))!.status, "REFUNDED");

    fake.setPaymentStatus(payment.merchantTransactionId, "success");
    await verifyChapChapPayment(payment._id, { force: true });
    await verifyChapChapPayment(payment._id, { force: true });
    await drainOutbox("w1");
    const fresh = (await Payment.findById(payment._id))!;
    assert.equal(fresh.requiresReview, true);
    const refunds = await F.Payout.find({ beneficiaryType: "buyer" });
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0]!.amount, 20_000);
    assert.equal(refunds[0]!.status, "succeeded");
    assert.equal(await F.Payout.countDocuments({ beneficiaryType: "seller" }), 0);
  });

  test("réconciliation : aucun doublon ni déséquilibre après un cycle complet", async () => {
    const { orders, buyer } = await paidMarketplaceOrder();
    for (const o of orders) await receive(o, buyer);
    await drainOutbox("w1");
    assert.deepEqual(await detectDuplicateOperations(), []);
  });
});
