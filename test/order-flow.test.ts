/**
 * Parcours commande via l'API HTTP : notification des livreurs, acceptation, rappel,
 * messagerie par paire, notifications par rôle, lecture, litige après réception.
 *
 *   npm test
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.NODE_ENV = "test";
process.env.FINANCE_WORKER_ENABLED = "false";
process.env.OTP_DEV_ECHO = "false";
process.env.RATE_LIMIT_MAX = "0";

const { MongoMemoryReplSet } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const { User } = await import("../src/models/user.js");
const { Session } = await import("../src/models/auth.js");
const { Order } = await import("../src/models/commerce.js");
const { Notification, Message } = await import("../src/models/social.js");
const { signToken } = await import("../src/utils/jwt.js");
const { createApp } = await import("../src/app.js");

let replSet: InstanceType<typeof MongoMemoryReplSet>;
let server: Server;
let base = "";
let seq = 300000;

type Actor = { id: string; token: string };

async function actor(kind: "buyer" | "seller" | "courier", zoneId?: mongoose.Types.ObjectId): Promise<Actor> {
  seq += 1;
  const audience = kind === "courier" ? "COURIER" : "CONSUMER";
  const user = await User.create({
    name: `${kind} ${seq}`,
    phone: `+22462${String(seq).padStart(7, "0")}`,
    email: `${randomUUID()}@fripcash.test`,
    emailVerified: true,
    phoneNumberVerified: true,
    authAudience: audience,
    seller: kind === "seller" ? { kind: "boutique", shopName: `Boutique ${seq}`, verificationStatus: "approved" } : null,
    courier: kind === "courier" ? { verificationStatus: "approved", isAvailable: true, zoneIds: zoneId ? [zoneId] : [] } : null,
  });
  const token = signToken({ sub: String(user._id), aud: audience });
  await Session.create({ userId: user._id, token, audience, expiresAt: new Date(Date.now() + 3_600_000) });
  return { id: String(user._id), token };
}

async function api(who: Actor, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function notes(who: Actor) {
  return Notification.find({ userId: who.id }).sort({ createdAt: 1 }).lean();
}

/** Commande payée en livraison FripCash, prête à être préparée. */
async function paidOrder(buyer: Actor, seller: Actor, zoneId: mongoose.Types.ObjectId) {
  return Order.create({
    buyerId: buyer.id,
    sellerId: seller.id,
    items: [{ title: "Veste en jean", quantity: 1, priceGnf: 50_000, netPriceGnf: 45_000, commissionGnf: 5_000 }],
    amountGnf: 50_000,
    shippingCostGnf: 10_000,
    status: "SELLER_NOTIFIED",
    escrowStatus: "held",
    fulfillmentMode: "courier",
    pickupZoneId: zoneId,
    address: { name: "Client", phone: "+224620000001" },
    timeline: [{ status: "SELLER_NOTIFIED", at: new Date() }],
  });
}

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("fripcash_flow"));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
});

describe("Livreurs", () => {
  test("préparer ne notifie personne ; « Notifier le livreur » ne prévient que la zone ; une seule acceptation", async () => {
    const zone = new mongoose.Types.ObjectId();
    const elsewhere = new mongoose.Types.ObjectId();
    const [buyer, seller] = [await actor("buyer"), await actor("seller")];
    const [c1, c2, far] = [await actor("courier", zone), await actor("courier", zone), await actor("courier", elsewhere)];
    const order = await paidOrder(buyer, seller, zone);

    assert.equal((await api(seller, "PATCH", `/orders/${order._id}/status`, { status: "PREPARING" })).status, 200);
    assert.equal((await notes(c1)).length, 0, "aucun livreur notifié à la préparation");
    assert.deepEqual(((await api(c1, "GET", "/courier/missions/open")).data as any[]).length, 0);

    assert.equal((await api(seller, "POST", `/orders/${order._id}/request-courier`)).status, 200);
    assert.equal((await notes(c1)).filter((n) => n.type === "mission").length, 1);
    assert.equal((await notes(c2)).filter((n) => n.type === "mission").length, 1);
    assert.equal((await notes(far)).length, 0, "hors zone : pas notifié");
    assert.equal(((await api(c2, "GET", "/courier/missions/open")).data as any[]).length, 1);

    const [a, b] = await Promise.all([
      api(c1, "POST", `/courier/missions/${order._id}/accept`),
      api(c2, "POST", `/courier/missions/${order._id}/accept`),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400], "un seul livreur obtient la course");
    const loser = a.status === 200 ? c2 : c1;
    assert.ok((await notes(loser)).some((n) => n.title === "Livraison acceptée par un autre livreur"));
    assert.equal(((await api(loser, "GET", "/courier/missions/open")).data as any[]).length, 0, "disparaît des autres comptes");
  });

  test("« Rappeler un livreur » annule l'acceptation et relance la zone", async () => {
    const zone = new mongoose.Types.ObjectId();
    const [buyer, seller] = [await actor("buyer"), await actor("seller")];
    const [c1, c2] = [await actor("courier", zone), await actor("courier", zone)];
    const order = await paidOrder(buyer, seller, zone);
    await api(seller, "POST", `/orders/${order._id}/request-courier`);
    assert.equal((await api(c1, "POST", `/courier/missions/${order._id}/accept`)).status, 200);

    assert.equal((await api(buyer, "POST", `/orders/${order._id}/recall-courier`)).status, 403, "réservé au vendeur");
    const recall = await api(seller, "POST", `/orders/${order._id}/recall-courier`);
    assert.equal(recall.status, 200);
    assert.equal(recall.data.status, "READY_FOR_PICKUP");
    assert.equal(recall.data.courierId, null);
    assert.ok((await notes(c1)).some((n) => n.title === "Course annulée par le vendeur"));
    assert.equal((await notes(c2)).filter((n) => n.title === "Nouvelle livraison disponible").length, 2, "zone relancée");
    assert.equal((await api(c2, "POST", `/courier/missions/${order._id}/accept`)).status, 200);

    await api(c2, "POST", `/courier/missions/${order._id}/progress`, { status: "COLLECTED" });
    assert.equal((await api(seller, "POST", `/orders/${order._id}/recall-courier`)).status, 400, "plus possible après collecte");
  });
});

describe("Messagerie et notifications par rôle", () => {
  test("trois discussions distinctes ; la fiche livreur n'apparaît jamais chez acheteur ↔ vendeur", async () => {
    const zone = new mongoose.Types.ObjectId();
    const [buyer, seller, courier] = [await actor("buyer"), await actor("seller"), await actor("courier", zone)];
    const order = await paidOrder(buyer, seller, zone);
    const bs = await api(buyer, "POST", "/conversations", { orderId: String(order._id) });
    assert.equal(bs.data.pair, "buyer_seller");
    assert.equal((await api(buyer, "POST", "/conversations", { orderId: String(order._id), with: "courier" })).status, 400);

    await api(seller, "POST", `/orders/${order._id}/request-courier`);
    await api(courier, "POST", `/courier/missions/${order._id}/accept`);
    const sc = await api(seller, "POST", "/conversations", { orderId: String(order._id), with: "courier" });
    assert.equal(sc.data.pair, "seller_courier");
    assert.equal((await api(buyer, "POST", "/conversations", { orderId: String(order._id), with: "courier" })).status, 403, "avant la collecte");

    const scMessages = (await api(seller, "GET", `/conversations/${sc.data.id}/messages`)).data as any[];
    assert.ok(scMessages.some((m) => m.kind === "courier"), "fiche livreur côté vendeur");
    const bsMessages = (await api(buyer, "GET", `/conversations/${bs.data.id}/messages`)).data as any[];
    assert.ok(!bsMessages.some((m) => m.kind === "courier"), "rien du livreur chez acheteur ↔ vendeur");
    assert.equal((await api(buyer, "GET", `/conversations/${sc.data.id}/messages`)).status, 403, "l'acheteur ne lit pas vendeur ↔ livreur");

    await api(courier, "POST", `/courier/missions/${order._id}/progress`, { status: "COLLECTED" });
    const bc = await api(buyer, "POST", "/conversations", { orderId: String(order._id), with: "courier" });
    assert.equal(bc.data.pair, "buyer_courier");
    assert.equal(await Message.countDocuments({ conversationId: bc.data.id, kind: "courier" }), 1, "le client découvre son livreur");

    const list = (await api(seller, "GET", "/conversations")).data as any[];
    assert.deepEqual(list.map((c) => c.pair).sort(), ["buyer_seller", "seller_courier"]);
    assert.ok(list.every((c) => c.orderId === String(order._id)));
  });

  test("chaque rôle reçoit SON texte ; le vendeur ne lit jamais « vérifie le colis »", async () => {
    const zone = new mongoose.Types.ObjectId();
    const [buyer, seller, courier] = [await actor("buyer"), await actor("seller"), await actor("courier", zone)];
    const order = await paidOrder(buyer, seller, zone);
    await api(seller, "POST", `/orders/${order._id}/request-courier`);
    await api(courier, "POST", `/courier/missions/${order._id}/accept`);
    await api(courier, "POST", `/courier/missions/${order._id}/progress`, { status: "COLLECTED" });
    await api(courier, "POST", `/courier/missions/${order._id}/progress`, { status: "IN_TRANSIT" });

    const sellerTexts = (await notes(seller)).map((n) => `${n.title} ${n.body}`).join(" | ");
    const buyerTexts = (await notes(buyer)).map((n) => `${n.title} ${n.body}`).join(" | ");
    assert.match(sellerTexts, /a récupéré le colis/);
    assert.doesNotMatch(sellerTexts, /vers toi|Vérifie l'article|ton colis/);
    assert.match(buyerTexts, /arrive vers toi/);
    assert.doesNotMatch(buyerTexts, /accepté la course et vient récupérer/, "info vendeur ↔ livreur jamais chez l'acheteur");
    assert.equal((await notes(courier)).filter((n) => n.type === "order").length, 0, "le livreur n'est pas notifié de ses propres actions");

    const view = (await api(buyer, "GET", `/orders/${order._id}`)).data;
    assert.ok(!view.timeline.some((t: any) => /livreur\(s\) de la zone/.test(t.note || "")), "notes vendeur masquées à l'acheteur");
    const sellerView = (await api(seller, "GET", `/orders/${order._id}`)).data;
    assert.ok(sellerView.timeline.some((t: any) => /livreur\(s\) de la zone/.test(t.note || "")));
  });

  test("ouvrir une discussion marque ses messages et notifications comme lus", async () => {
    const zone = new mongoose.Types.ObjectId();
    const [buyer, seller] = [await actor("buyer"), await actor("seller")];
    const order = await paidOrder(buyer, seller, zone);
    const conv = await api(buyer, "POST", "/conversations", { orderId: String(order._id) });
    await api(buyer, "POST", `/conversations/${conv.data.id}/messages`, { body: "Bonjour" });
    await api(buyer, "POST", `/conversations/${conv.data.id}/messages`, { body: "Toujours dispo ?" });
    let list = (await api(seller, "GET", "/conversations")).data as any[];
    assert.equal(list[0].unread, 2);
    assert.equal((await api(seller, "POST", `/conversations/${conv.data.id}/read`)).data.read, 2);
    list = (await api(seller, "GET", "/conversations")).data as any[];
    assert.equal(list[0].unread, 0);
    assert.equal((await notes(seller)).filter((n) => n.type === "message" && !n.read).length, 0);
  });
});

describe("Litiges", () => {
  test("impossible après la confirmation de réception", async () => {
    const zone = new mongoose.Types.ObjectId();
    const [buyer, seller] = [await actor("buyer"), await actor("seller")];
    const order = await paidOrder(buyer, seller, zone);
    await Order.updateOne({ _id: order._id }, { $set: { status: "DELIVERED", buyerConfirmedAt: new Date() } });
    const res = await api(buyer, "POST", `/orders/${order._id}/disputes`, { reason: "Article abîmé" });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, "DISPUTE_AFTER_RECEIPT");
  });
});
