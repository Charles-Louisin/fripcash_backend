/**
 * Tests de sécurité et de tenue en charge de l'API HTTP :
 * authentification, cloisonnement des données (BOLA), injection NoSQL, ReDoS, webhooks
 * non signés, tailles de requêtes, en-têtes de sécurité, requêtes simultanées.
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
const bcrypt = (await import("bcryptjs")).default;
const { User } = await import("../src/models/user.js");
const { Session } = await import("../src/models/auth.js");
const { Order } = await import("../src/models/commerce.js");
const { Listing } = await import("../src/models/listing.js");
const { signToken } = await import("../src/utils/jwt.js");
const { createApp } = await import("../src/app.js");

let replSet: InstanceType<typeof MongoMemoryReplSet>;
let server: Server;
let base = "";
let seq = 500000;

type Actor = { id: string; token: string };

async function actor(kind: "buyer" | "seller" = "buyer"): Promise<Actor> {
  seq += 1;
  const user = await User.create({
    name: `${kind} ${seq}`,
    phone: `+22462${String(seq).padStart(7, "0")}`,
    email: `${randomUUID()}@fripcash.test`,
    emailVerified: true,
    phoneNumberVerified: true,
    authAudience: "CONSUMER",
    seller: kind === "seller" ? { kind: "boutique", shopKind: "standard", shopName: `Boutique ${seq}` } : null,
  });
  const token = signToken({ sub: String(user._id), aud: "CONSUMER" });
  await Session.create({ userId: user._id, token, audience: "CONSUMER", expiresAt: new Date(Date.now() + 3_600_000) });
  return { id: String(user._id), token };
}

async function call(method: string, path: string, opts: { who?: Actor; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path.startsWith("/api") ? "" : "/api/v1"}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.who ? { Authorization: `Bearer ${opts.who.token}` } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data: any = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

async function orderBetween(buyer: Actor, seller: Actor) {
  return Order.create({
    buyerId: buyer.id,
    sellerId: seller.id,
    items: [{ title: "Sac", quantity: 1, priceGnf: 50_000, netPriceGnf: 45_000, commissionGnf: 5_000 }],
    amountGnf: 50_000,
    status: "PAID",
    escrowStatus: "held",
    address: { name: "Client", phone: "+224620000001" },
    timeline: [{ status: "PAID", at: new Date() }],
  });
}

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("fripcash_security"));
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

describe("Authentification", () => {
  test("routes privées refusées sans jeton, avec un jeton forgé ou après déconnexion", async () => {
    assert.equal((await call("GET", "/orders/purchases")).status, 401);
    const forged = { id: "x", token: signToken({ sub: new mongoose.Types.ObjectId().toString(), aud: "CONSUMER" }) };
    assert.equal((await call("GET", "/orders/purchases", { who: forged })).status, 401, "jeton sans session");
    const tampered = { id: "x", token: `${(await actor()).token.slice(0, -4)}AAAA` };
    assert.equal((await call("GET", "/orders/purchases", { who: tampered })).status, 401, "signature altérée");
  });

  test("injection NoSQL sur la connexion : un objet à la place de l'e-mail est rejeté", async () => {
    await User.create({
      name: "Victime",
      email: "victime@fripcash.test",
      passwordHash: await bcrypt.hash("Secret123!", 4),
      emailVerified: true,
    });
    const injected = await call("POST", "/auth/sign-in/email", { body: { email: { $ne: null }, password: { $ne: null } } });
    assert.equal(injected.status, 400);
    assert.equal(injected.data?.token, undefined);
    const wrong = await call("POST", "/auth/sign-in/email", { body: { email: "victime@fripcash.test", password: "mauvais" } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data?.token, undefined);
  });

  test("un client n'accède pas à l'administration", async () => {
    const buyer = await actor();
    assert.equal((await call("GET", "/admin/me", { who: buyer })).status, 403);
    assert.equal((await call("GET", "/admin/payouts", { who: buyer })).status, 403);
  });
});

describe("Cloisonnement des données (BOLA)", () => {
  test("un tiers ne lit ni ne modifie la commande d'un autre", async () => {
    const [buyer, seller, intruder] = [await actor(), await actor("seller"), await actor()];
    const order = await orderBetween(buyer, seller);
    assert.equal((await call("GET", `/orders/${order._id}`, { who: buyer })).status, 200);
    assert.equal((await call("GET", `/orders/${order._id}`, { who: intruder })).status, 403);
    const patch = await call("PATCH", `/orders/${order._id}/status`, { who: intruder, body: { status: "DELIVERED" } });
    assert.ok([403, 404].includes(patch.status), `statut ${patch.status}`);
    assert.equal(patch.status, 403, "refusé avant toute validation métier");
    assert.equal((await Order.findById(order._id).lean())?.status, "PAID", "commande inchangée");
  });

  test("chaque partie ne peut demander que les statuts de son rôle", async () => {
    const [buyer, seller] = [await actor(), await actor("seller")];
    const order = await orderBetween(buyer, seller);
    await Order.updateOne({ _id: order._id }, { $set: { status: "ORDERED" } });
    // L'acheteur ne peut pas déclarer lui-même sa commande payée.
    assert.equal((await call("PATCH", `/orders/${order._id}/status`, { who: buyer, body: { status: "PAID" } })).status, 403);
    assert.equal((await call("PATCH", `/orders/${order._id}/status`, { who: seller, body: { status: "PAID" } })).status, 403);
    await Order.updateOne({ _id: order._id }, { $set: { status: "PAID" } });
    // Préparer : le vendeur oui, l'acheteur non.
    assert.equal((await call("PATCH", `/orders/${order._id}/status`, { who: buyer, body: { status: "PREPARING" } })).status, 403);
    assert.equal((await call("PATCH", `/orders/${order._id}/status`, { who: seller, body: { status: "PREPARING" } })).status, 200);
    assert.equal((await Order.findById(order._id).lean())?.status, "PREPARING");
  });

  test("identifiant invalide : erreur propre, jamais une 500", async () => {
    const buyer = await actor();
    const res = await call("GET", "/orders/not-an-id", { who: buyer });
    assert.ok(res.status === 400 || res.status === 404, `statut ${res.status}`);
  });
});

describe("Entrées hostiles", () => {
  test("recherche avec motif ReDoS : traitée comme du texte, rapidement", async () => {
    const t0 = Date.now();
    const res = await call("GET", `/catalog/shops?q=${encodeURIComponent("(a+)+$" + "a".repeat(40) + "!")}`);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 1500, "réponse rapide");
  });

  test("paramètres de requête en objet ignorés (pas d'opérateur Mongo via l'URL)", async () => {
    const res = await call("GET", "/catalog/shops?shopKind[$ne]=x&limit[$gt]=0");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
  });

  test("corps JSON trop volumineux refusé (413)", async () => {
    const res = await call("POST", "/auth/sign-in/email", { raw: JSON.stringify({ email: "a@b.c", password: "x".repeat(2 * 1024 * 1024) }) });
    assert.equal(res.status, 413);
  });

  test("webhooks de paiement et de reversement sans signature valide rejetés", async () => {
    const body = JSON.stringify({ operation_id: "OP-1", order_id: "FC-1", status: { code: "success" } });
    for (const path of ["/payments/webhook/chapchappay", "/payouts/webhook/chapchappay"]) {
      const res = await call("POST", path, { raw: body, headers: { "CCP-HMAC-Signature": "deadbeef" } });
      assert.ok(res.status === 401 || res.status === 403, `${path} → ${res.status}`);
    }
  });

  test("en-têtes de sécurité présents, technologie masquée", async () => {
    const res = await call("GET", "/health");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("strict-transport-security"));
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});

describe("Micro-cache public", () => {
  test("partage les lectures publiques mais jamais une réponse propre à un utilisateur", async () => {
    const buyer = await actor();
    await call("GET", "/catalog/categories");
    assert.equal((await call("GET", "/catalog/categories")).headers.get("x-cache"), "HIT", "lecture publique partagée");
    // Liste des boutiques d'un utilisateur connecté (« aimée par moi ») : jamais mise en cache.
    await call("GET", "/catalog/shops?limit=3", { who: buyer });
    assert.equal((await call("GET", "/catalog/shops?limit=3", { who: buyer })).headers.get("x-cache"), null);
    // Ses propres annonces : jamais en cache.
    await call("GET", "/listings?mine=1", { who: buyer });
    assert.equal((await call("GET", "/listings?mine=1", { who: buyer })).headers.get("x-cache"), null);
  });
});

describe("Tenue en charge", () => {
  test("100 clients simultanés × 10 requêtes : toutes servies, sans erreur", async () => {
    const seller = await actor("seller");
    await Listing.insertMany(
      Array.from({ length: 60 }, (_, i) => ({
        sellerId: seller.id,
        title: `Article ${i}`,
        netPriceGnf: 10_000,
        priceGnf: 10_800,
        commissionRate: 0.08,
        commissionAmountGnf: 800,
        quantity: 3,
        status: "ACTIVE",
        destination: "ARTICLES_NEUFS",
      }))
    );
    const paths = ["/listings?limit=24", "/catalog/shops?limit=12", "/catalog/shops/counts", "/catalog/categories"];
    const CLIENTS = 100;
    const PER_CLIENT = 10;
    const results: { status: number | string; ms: number }[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, c) => {
        for (let k = 0; k < PER_CLIENT; k += 1) {
          const started = Date.now();
          try {
            const r = await fetch(`${base}/api/v1${paths[(c + k) % paths.length]}`);
            await r.arrayBuffer();
            results.push({ status: r.status, ms: Date.now() - started });
          } catch (e) {
            results.push({ status: `réseau: ${((e as Error).cause as Error)?.message || (e as Error).message}`, ms: Date.now() - started });
          }
        }
      })
    );
    const total = Date.now() - t0;
    const failed = results.filter((r) => r.status !== 200);
    const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(
      `charge : ${results.length} requêtes (${CLIENTS} clients) en ${total} ms — ${Math.round(results.length / (total / 1000))} req/s, médiane ${p50} ms, p95 ${p95} ms`
    );
    assert.equal(failed.length, 0, `échecs : ${[...new Set(failed.map((f) => f.status))].join(", ")}`);
  });

});
