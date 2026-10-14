import { connectDb, disconnectDb } from "../src/db/connect.js";
import { User } from "../src/models/user.js";
import { Order, Payment, Wallet, Ledger } from "../src/models/commerce.js";
import { Listing } from "../src/models/listing.js";
import { getOrCreateWallet, holdEscrow, releaseEscrow, refundEscrow } from "../src/services/wallet.js";
import { payoutOrderToSeller, refundOrderToBuyer } from "../src/services/payments.js";
import { sid } from "../src/utils/ids.js";

const API = process.env.PUBLIC_API_URL || "http://127.0.0.1:5000";
const FAIL: string[] = [];
let pass = 0;

function assert(cond: unknown, label: string) {
  if (cond) {
    pass += 1;
    console.log(`  OK  ${label}`);
  } else {
    FAIL.push(label);
    console.log(`  FAIL ${label}`);
  }
}

async function login(email: string, password: string) {
  const res = await fetch(`${API}/api/v1/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  const token = data.token || data.session?.token;
  if (!token) throw new Error(`Login ${email} failed: ${res.status} ${JSON.stringify(data)}`);
  return token as string;
}

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  await connectDb();
  const stamp = Date.now();
  const buyer = await User.create({
    name: "Test Buyer Cycle",
    email: `cycle-buyer-${stamp}@fripcash.test`,
    phone: `+22462${String(stamp).slice(-7)}`,
    authAudience: "CONSUMER",
    canBuy: true,
    emailVerified: true,
    phoneNumberVerified: true,
  });
  const seller = await User.create({
    name: "Test Seller Cycle",
    email: `cycle-seller-${stamp}@fripcash.test`,
    phone: `+22465${String(stamp).slice(-7)}`,
    authAudience: "CONSUMER",
    canBuy: true,
    emailVerified: true,
    phoneNumberVerified: true,
    seller: {
      kind: "boutique",
      shopKind: "standard",
      shopName: "Cycle Shop",
      shopDescription: "Test",
      verificationStatus: "approved",
      listingDestination: "ARTICLES_NEUFS",
      orangeMoneyPhone: "+224620000002",
    },
  });
  const sellerId = sid(seller._id);
  const buyerId = sid(buyer._id);
  const listing = await Listing.create({
    sellerId: seller._id,
    title: "Article cycle test",
    description: "test",
    netPriceGnf: 400,
    priceGnf: 400,
    commissionRate: 0,
    commissionAmountGnf: 0,
    quantity: 10,
    status: "ACTIVE",
    destination: "ARTICLES_NEUFS",
  });

  console.log("\n== Wallet hold / release / refund ==");
  const orderHold = await Order.create({
    buyerId: buyer._id,
    sellerId: seller._id,
    items: [
      {
        listingId: listing._id,
        title: listing.title,
        quantity: 1,
        priceGnf: 400,
        netPriceGnf: 400,
        commissionGnf: 0,
      },
    ],
    amountGnf: 400,
    commissionGnf: 0,
    shippingCostGnf: 0,
    status: "SELLER_NOTIFIED",
    escrowStatus: "held",
    fulfillmentMode: "courier",
    paymentMethod: "OM_GN",
    address: { phone: "+224620000001", paymentPhone: "+224620000001", name: "Awa", email: "a@b.c", line: "Kaloum" },
  });

  await holdEscrow(sellerId, 400, sid(orderHold._id));
  let sw = await getOrCreateWallet(sellerId);
  assert(sw.reservedGnf === 400, `séquestre vendeur = 400 (got ${sw.reservedGnf})`);
  assert(sw.availableGnf === 0, `disponible vendeur = 0 après hold (got ${sw.availableGnf})`);

  await releaseEscrow(sellerId, 400, sid(orderHold._id));
  sw = await getOrCreateWallet(sellerId);
  assert(sw.reservedGnf === 0, `séquestre = 0 après libération (got ${sw.reservedGnf})`);
  assert(sw.availableGnf === 400, `disponible = 400 après libération (got ${sw.availableGnf})`);

  const orderRefund = await Order.create({
    buyerId: buyer._id,
    sellerId: seller._id,
    items: [
      {
        listingId: listing._id,
        title: listing.title,
        quantity: 1,
        priceGnf: 400,
        netPriceGnf: 400,
        commissionGnf: 0,
      },
    ],
    amountGnf: 400,
    commissionGnf: 0,
    shippingCostGnf: 0,
    status: "SELLER_NOTIFIED",
    escrowStatus: "held",
    fulfillmentMode: "courier",
    paymentMethod: "OM_GN",
    address: { phone: "+224620000001", paymentPhone: "+224620000001", name: "Awa", email: "a@b.c", line: "Kaloum" },
  });
  await holdEscrow(sellerId, 400, sid(orderRefund._id));
  sw = await getOrCreateWallet(sellerId);
  assert(sw.reservedGnf === 400, `séquestre = 400 avant refund (got ${sw.reservedGnf})`);
  await refundEscrow(sellerId, buyerId, 400, sid(orderRefund._id));
  sw = await getOrCreateWallet(sellerId);
  const bw = await getOrCreateWallet(buyerId);
  assert(sw.reservedGnf === 0, `séquestre vendeur = 0 après refund (got ${sw.reservedGnf})`);
  assert(sw.availableGnf === 400, `disponible vendeur inchangé (400) après refund (got ${sw.availableGnf})`);

  console.log("\n== payout / refund wallet fallback (< 500 GNF) ==");
  orderHold.escrowStatus = "held";
  orderHold.status = "DELIVERED";
  await orderHold.save();
  await holdEscrow(sellerId, 400, sid(orderHold._id));
  const beforePayout = await getOrCreateWallet(sellerId);
  const reservedBefore = beforePayout.reservedGnf;
  const availableBefore = beforePayout.availableGnf;
  const payout = await payoutOrderToSeller(orderHold, 400, "test payout");
  assert(payout.mode === "wallet", `payout < 500 passe au wallet (got ${payout.mode})`);
  const afterPayout = await getOrCreateWallet(sellerId);
  assert(
    afterPayout.reservedGnf === reservedBefore - 400,
    `séquestre diminue de 400 au payout (${reservedBefore} → ${afterPayout.reservedGnf})`
  );
  assert(
    afterPayout.availableGnf === availableBefore + 400,
    `disponible augmente de 400 au payout (${availableBefore} → ${afterPayout.availableGnf})`
  );
  const freshHold = await Order.findById(orderHold._id);
  assert(freshHold?.escrowStatus === "released", `order escrow released (got ${freshHold?.escrowStatus})`);
  assert(freshHold?.status === "FUNDS_RELEASED", `order FUNDS_RELEASED (got ${freshHold?.status})`);

  orderRefund.escrowStatus = "held";
  orderRefund.status = "SELLER_NOTIFIED";
  await orderRefund.save();
  await holdEscrow(sellerId, 400, sid(orderRefund._id));
  const buyerBefore = (await getOrCreateWallet(buyerId)).availableGnf;
  const refund = await refundOrderToBuyer(orderRefund, 400, "test refund");
  assert(refund.mode === "wallet", `refund < 500 passe au wallet (got ${refund.mode})`);
  const sellerAfterRefund = await getOrCreateWallet(sellerId);
  const buyerAfter = await getOrCreateWallet(buyerId);
  assert(
    sellerAfterRefund.reservedGnf === afterPayout.reservedGnf,
    `séquestre vendeur redescend après refund (got ${sellerAfterRefund.reservedGnf})`
  );
  assert(
    buyerAfter.availableGnf === buyerBefore + 400,
    `acheteur crédité de 400 (${buyerBefore} → ${buyerAfter.availableGnf})`
  );
  const freshRefund = await Order.findById(orderRefund._id);
  assert(freshRefund?.escrowStatus === "refunded", `order escrow refunded (got ${freshRefund?.escrowStatus})`);

  console.log("\n== HTTP wallet / checkout schemas ==");
  try {
    const seedBuyer = await login("buyer@fripcash.test", "Password123!");
    const seedSeller = await login("seller@fripcash.test", "Password123!");

    const bal = await api(seedSeller, "/wallet/balance");
    assert(bal.status === 200, `GET /wallet/balance 200`);
    assert(typeof bal.data.availableBalanceGnf === "number", "availableBalanceGnf number");
    assert(typeof bal.data.reservedBalanceGnf === "number", "reservedBalanceGnf number");
    assert(
      bal.data.balanceGnf === bal.data.availableBalanceGnf + bal.data.reservedBalanceGnf,
      `balanceGnf = disponible + séquestre (${bal.data.balanceGnf} = ${bal.data.availableBalanceGnf}+${bal.data.reservedBalanceGnf})`
    );

    const ledger = await api(seedSeller, "/wallet/ledger");
    assert(ledger.status === 200, "GET /wallet/ledger 200");
    assert(Array.isArray(ledger.data.items), "ledger.items array");

    const sales = await api(seedSeller, "/orders/sales");
    assert(sales.status === 200 && Array.isArray(sales.data), "GET /orders/sales 200");
    const purchases = await api(seedBuyer, "/orders/purchases");
    assert(purchases.status === 200 && Array.isArray(purchases.data), "GET /orders/purchases 200");

    const checkoutBad = await api(seedBuyer, "/checkout", {
      method: "POST",
      body: JSON.stringify({
        fulfillmentMode: "courier",
        paymentMethod: "OM_GN",
        address: "Kaloum",
        city: "Conakry",
        phone: "123",
        name: "Awa",
        email: "not-an-email",
        mobileNumber: "123",
      }),
    });
    assert(checkoutBad.status >= 400, `POST /cart/checkout refuse téléphone/email invalides (${checkoutBad.status})`);

    const checkoutMmSchema = await api(seedBuyer, "/checkout", {
      method: "POST",
      body: JSON.stringify({
        fulfillmentMode: "courier",
        paymentMethod: "MTN_GN",
        address: "Kaloum",
        city: "Conakry",
        phone: "+224650000001",
        name: "Awa Test",
        email: "buyer@fripcash.test",
        mobileNumber: "+224620000001",
      }),
    });
    assert(
      checkoutMmSchema.status >= 400,
      `POST /cart/checkout refuse MM opérateur ≠ numéro (${checkoutMmSchema.status})`
    );

    const checkoutOmNoOtp = await api(seedBuyer, "/checkout", {
      method: "POST",
      body: JSON.stringify({
        fulfillmentMode: "courier",
        paymentMethod: "OM_GN",
        address: "Kaloum",
        city: "Conakry",
        phone: "+224620000001",
        name: "Awa Test",
        email: "buyer@fripcash.test",
        mobileNumber: "+224620000001",
      }),
    });
    assert(
      checkoutOmNoOtp.data?.code !== "OTP" && checkoutOmNoOtp.data?.error !== "OTP",
      `POST /checkout Orange sans OTP n'est plus refusé pour OTP (${checkoutOmNoOtp.status} ${checkoutOmNoOtp.data?.code || checkoutOmNoOtp.data?.error || ""})`
    );

    const checkoutCardSchema = await api(seedBuyer, "/checkout", {
      method: "POST",
      body: JSON.stringify({
        fulfillmentMode: "courier",
        paymentMethod: "CINETPAY",
        address: "Kaloum",
        city: "Conakry",
        phone: "+224620000001",
        name: "Awa Test",
        email: "buyer@fripcash.test",
        mobileNumber: "+224620000001",
      }),
    });
    assert(
      checkoutCardSchema.status === 200 || checkoutCardSchema.status >= 400,
      `POST /checkout CINETPAY répond (${checkoutCardSchema.status})`
    );

    const withdrawBad = await api(seedSeller, "/wallet/withdraw", {
      method: "POST",
      body: JSON.stringify({ amountGnf: 100, phone: "+224620000002" }),
    });
    assert(withdrawBad.status >= 400, `POST /wallet/withdraw refuse < 500 GNF (${withdrawBad.status})`);

    const payLookup = await api(seedBuyer, "/payments/does-not-exist");
    assert(payLookup.status === 404 || payLookup.status === 400, `GET /payments/:id inconnu (${payLookup.status})`);
  } catch (err) {
    assert(false, `HTTP tests: ${err instanceof Error ? err.message : err}`);
  }

  await Payment.deleteMany({ buyerId: buyer._id });
  await Order.deleteMany({ $or: [{ buyerId: buyer._id }, { sellerId: seller._id }] });
  await Ledger.deleteMany({ userId: { $in: [buyer._id, seller._id] } });
  await Wallet.deleteMany({ userId: { $in: [buyer._id, seller._id] } });
  await Listing.deleteOne({ _id: listing._id });
  await User.deleteMany({ _id: { $in: [buyer._id, seller._id] } });

  console.log(`\n${pass} OK · ${FAIL.length} FAIL`);
  if (FAIL.length) {
    console.log(FAIL.map((f) => ` - ${f}`).join("\n"));
    process.exitCode = 1;
  }
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await disconnectDb().catch(() => undefined);
});
