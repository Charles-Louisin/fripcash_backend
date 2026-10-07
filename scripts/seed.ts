import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "../src/db/connect.js";
import { User } from "../src/models/user.js";
import { Category, DeliveryTariff, Partner, PlatformSettings, Zone } from "../src/models/catalog.js";
import { Listing } from "../src/models/listing.js";
import { Order, Wallet } from "../src/models/commerce.js";
import { Offer } from "../src/models/social.js";
import { Dispute } from "../src/models/ops.js";
import { previewBuyerPrice } from "../src/utils/pricing.js";
import { holdEscrow } from "../src/services/wallet.js";

async function main() {
  await connectDb();

  try {
    await User.collection.drop();
  } catch {
    await User.deleteMany({});
  }
  await Promise.all([
    Category.deleteMany({}),
    Zone.deleteMany({}),
    DeliveryTariff.deleteMany({}),
    Listing.deleteMany({}),
    Order.deleteMany({}),
    Wallet.deleteMany({}),
    Offer.deleteMany({}),
    Dispute.deleteMany({}),
    Partner.deleteMany({}),
    PlatformSettings.deleteMany({}),
  ]);

  await PlatformSettings.create({ key: "default" });
  const hash = await bcrypt.hash("Password123!", 10);

  const admin = await User.create({
    name: "Admin FripCash",
    email: "admin@fripcash.test",
    passwordHash: hash,
    isAdmin: true,
    authAudience: "ADMIN",
    canBuy: false,
    emailVerified: true,
  });

  const buyer = await User.create({
    name: "Awa Diallo",
    email: "buyer@fripcash.test",
    phone: "+224620000001",
    passwordHash: hash,
    authAudience: "CONSUMER",
    canBuy: true,
    phoneNumberVerified: true,
    emailVerified: true,
  });

  const seller = await User.create({
    name: "Mamadou Camara",
    email: "seller@fripcash.test",
    phone: "+224620000002",
    passwordHash: hash,
    authAudience: "CONSUMER",
    canBuy: true,
    phoneNumberVerified: true,
    emailVerified: true,
    seller: {
      kind: "particulier",
      shopKind: null,
      shopName: "Chez Mamadou",
      verificationStatus: "approved",
      listingDestination: "SECONDE_MAIN",
    },
  });

  const boutique = await User.create({
    name: "Boutique Kaloum",
    email: "boutique@fripcash.test",
    passwordHash: hash,
    authAudience: "CONSUMER",
    canBuy: true,
    emailVerified: true,
    seller: {
      kind: "boutique",
      shopKind: "standard",
      shopName: "Boutique Kaloum",
      verificationStatus: "approved",
      listingDestination: "ARTICLES_NEUFS",
    },
  });

  const proximite = await User.create({
    name: "Épicerie Matam",
    email: "proximite@fripcash.test",
    passwordHash: hash,
    authAudience: "CONSUMER",
    canBuy: true,
    seller: {
      kind: "boutique",
      shopKind: "proximite",
      shopName: "Épicerie Matam",
      verificationStatus: "pending",
      listingDestination: "QUARTIER_BOUTIQUES",
    },
  });

  const courier = await User.create({
    name: "Ibrahima Livreur",
    email: "courier@fripcash.test",
    phone: "+224620000003",
    passwordHash: hash,
    authAudience: "COURIER",
    canBuy: false,
    courier: {
      verificationStatus: "approved",
      isAvailable: true,
      vehicle: "Moto",
      plate: "GN-1234-AB",
    },
  });

  const zones = await Zone.insertMany([
    { code: "Z1", nameFr: "Kaloum", nameEn: "Kaloum" },
    { code: "Z2", nameFr: "Dixinn", nameEn: "Dixinn" },
    { code: "Z3", nameFr: "Matam", nameEn: "Matam" },
    { code: "Z4", nameFr: "Ratoma", nameEn: "Ratoma" },
    { code: "Z5", nameFr: "Matoto", nameEn: "Matoto" },
  ]);

  const tariffs = [];
  for (const a of zones) {
    for (const b of zones) {
      tariffs.push({
        fromZoneId: a._id,
        toZoneId: b._id,
        amountGnf: a._id.equals(b._id) ? 10000 : 25000,
      });
    }
  }
  await DeliveryTariff.insertMany(tariffs);

  const mode = await Category.create({
    nameFr: "Mode",
    nameEn: "Fashion",
    slug: "mode",
    destination: "SECONDE_MAIN",
    sortOrder: 1,
    imageUrl: "https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=800",
  });
  const electro = await Category.create({
    nameFr: "Électronique",
    nameEn: "Electronics",
    slug: "electronique",
    destination: "ARTICLES_NEUFS",
    sortOrder: 2,
    imageUrl: "https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800",
  });
  const maison = await Category.create({
    nameFr: "Maison",
    nameEn: "Home",
    slug: "maison",
    destination: "ARTICLES_NEUFS",
    sortOrder: 3,
    imageUrl: "https://images.unsplash.com/photo-1484101403633-562f891dc89a?w=800",
  });
  const enseignes = await Category.create({
    nameFr: "Enseignes",
    nameEn: "Retail",
    slug: "enseignes",
    destination: "ENSEIGNES",
    sortOrder: 4,
    imageUrl: "https://images.unsplash.com/photo-1604719312566-8912e9227c6a?w=800",
  });

  const subs = [
    { parent: mode, nameFr: "Hommes", nameEn: "Men", slug: "hommes", dest: "SECONDE_MAIN" },
    { parent: mode, nameFr: "Femmes", nameEn: "Women", slug: "femmes", dest: "SECONDE_MAIN" },
    { parent: mode, nameFr: "Enfants", nameEn: "Kids", slug: "enfants", dest: "SECONDE_MAIN" },
    { parent: electro, nameFr: "Téléphones", nameEn: "Phones", slug: "telephones", dest: "ARTICLES_NEUFS" },
    { parent: electro, nameFr: "Accessoires", nameEn: "Accessories", slug: "accessoires", dest: "ARTICLES_NEUFS" },
    { parent: maison, nameFr: "Décoration", nameEn: "Decor", slug: "decoration", dest: "ARTICLES_NEUFS" },
    { parent: maison, nameFr: "Cuisine", nameEn: "Kitchen", slug: "cuisine", dest: "ARTICLES_NEUFS" },
  ];
  const createdSubs = [];
  for (const s of subs) {
    createdSubs.push(
      await Category.create({
        parentId: s.parent._id,
        nameFr: s.nameFr,
        nameEn: s.nameEn,
        slug: s.slug,
        destination: s.dest,
        sortOrder: 10,
      })
    );
  }

  const pics = [
    "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800",
    "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800",
    "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800",
    "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=800",
    "https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=800",
    "https://images.unsplash.com/photo-1560343090-f0409e92791a?w=800",
  ];

  const listingSpecs = [
    { seller, title: "Baskets Nike vintage", net: 45000, dest: "SECONDE_MAIN", cat: createdSubs[0], qty: 1, neg: true },
    { seller, title: "Veste en jean", net: 35000, dest: "SECONDE_MAIN", cat: createdSubs[1], qty: 1, neg: true },
    { seller, title: "Sac à main cuir", net: 80000, dest: "SECONDE_MAIN", cat: createdSubs[1], qty: 1, neg: false },
    { seller: boutique, title: "Écouteurs Bluetooth", net: 120000, dest: "ARTICLES_NEUFS", cat: createdSubs[4], qty: 8, neg: false },
    { seller: boutique, title: "Téléphone reconditionné", net: 450000, dest: "ARTICLES_NEUFS", cat: createdSubs[3], qty: 3, neg: true },
    { seller: boutique, title: "Lampe de bureau", net: 55000, dest: "ARTICLES_NEUFS", cat: createdSubs[5], qty: 5, neg: false },
  ];

  const listings = [];
  for (const [i, spec] of listingSpecs.entries()) {
    const rate = 0.08;
    const priceGnf = previewBuyerPrice(spec.net, rate);
    listings.push(
      await Listing.create({
        sellerId: spec.seller._id,
        categoryId: spec.cat._id,
        zoneId: zones[0]._id,
        title: spec.title,
        description: `${spec.title} en excellent état — seed FripCash.`,
        netPriceGnf: spec.net,
        priceGnf,
        commissionRate: rate,
        commissionAmountGnf: priceGnf - spec.net,
        quantity: spec.qty,
        negotiable: spec.neg,
        destination: spec.dest,
        conditionNote: spec.dest === "SECONDE_MAIN" ? "Très bon état" : "Neuf",
        status: "ACTIVE",
        media: [{ storageKey: `seed/${i}`, url: pics[i], mimeType: "image/jpeg", sortOrder: 0 }],
      })
    );
  }

  const l0 = listings[0];
  const order = await Order.create({
    buyerId: buyer._id,
    sellerId: seller._id,
    items: [
      {
        listingId: l0._id,
        title: l0.title,
        quantity: 1,
        priceGnf: l0.priceGnf,
        netPriceGnf: l0.netPriceGnf,
        commissionGnf: l0.commissionAmountGnf,
      },
    ],
    amountGnf: l0.priceGnf,
    commissionGnf: l0.commissionAmountGnf,
    status: "PAID",
    escrowStatus: "held",
    fulfillmentMode: "courier",
    paymentMethod: "orange_money",
    timeline: [{ status: "PAID", at: new Date() }],
  });
  await holdEscrow(String(seller._id), l0.netPriceGnf, String(order._id));

  await Offer.create({
    listingId: listings[1]._id,
    buyerId: buyer._id,
    sellerId: seller._id,
    amountGnf: 30000,
    message: "Je peux passer aujourd'hui",
    status: "pending",
  });

  await Dispute.create({
    orderId: order._id,
    openedBy: buyer._id,
    openerRole: "buyer",
    reason: "Article différent de la photo (seed)",
    status: "open",
  });

  await Partner.create({ name: "Supermarché Kaloum", kind: "enseigne", status: "active" });

  for (const u of [admin, buyer, seller, boutique, proximite, courier]) {
    await Wallet.findOneAndUpdate({ userId: u._id }, {}, { upsert: true });
  }

  console.log("Seed OK");
  console.log("  admin@fripcash.test / Password123!");
  console.log("  buyer@fripcash.test / Password123!");
  console.log("  seller@fripcash.test / Password123!");
  console.log("  courier@fripcash.test / Password123!");
  console.log("  OTP GN: +224620000001 code 000000");

  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
