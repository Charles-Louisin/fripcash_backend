/**
 * Ajoute une boutique de quartier et une enseigne, validées, avec 3 articles chacune.
 * Ne vide pas la base : relancer le script remet simplement ces deux comptes et leurs articles à jour.
 *
 *   npm run seed:shops
 */
import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "../src/db/connect.js";
import { User } from "../src/models/user.js";
import { Category, Zone } from "../src/models/catalog.js";
import { Listing } from "../src/models/listing.js";
import { Wallet } from "../src/models/commerce.js";
import { getSettings } from "../src/services/notify.js";
import { destinationForSeller, previewBuyerPrice } from "../src/utils/pricing.js";

type ShopSpec = {
  email: string;
  name: string;
  phone: string;
  shopKind: "proximite" | "enseigne";
  shopName: string;
  description: string;
  coverUrl: string;
  storeAddress: string;
  neighborhood: string;
  landmark: string;
  openingTime: string;
  closingTime: string;
  zoneName: string;
  items: { title: string; net: number; qty: number; image: string; description: string }[];
};

const SHOPS: ShopSpec[] = [
  {
    email: "quartier@fripcash.test",
    name: "Fatoumata Sylla",
    phone: "+224620000010",
    shopKind: "proximite",
    shopName: "Chez Fanta – Madina",
    description: "Boutique de quartier : vêtements, pagnes et accessoires du quotidien, à retirer sur place.",
    coverUrl: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200",
    storeAddress: "Marché de Madina, allée 4",
    neighborhood: "Madina",
    landmark: "En face de la pharmacie centrale",
    openingTime: "08:00",
    closingTime: "19:00",
    zoneName: "Matam",
    items: [
      {
        title: "Pagne wax 6 yards",
        net: 85000,
        qty: 12,
        image: "https://images.unsplash.com/photo-1590736969955-71cc94901144?w=800",
        description: "Pagne wax 100 % coton, motifs vifs, 6 yards.",
      },
      {
        title: "Sandales en cuir artisanales",
        net: 60000,
        qty: 8,
        image: "https://images.unsplash.com/photo-1603487742131-4160ec999306?w=800",
        description: "Sandales cousues main, cuir véritable, tailles 38 à 44.",
      },
      {
        title: "Sac cabas tressé",
        net: 45000,
        qty: 10,
        image: "https://images.unsplash.com/photo-1544816155-12df9643f363?w=800",
        description: "Grand cabas tressé, idéal pour le marché ou la plage.",
      },
    ],
  },
  {
    email: "enseigne@fripcash.test",
    name: "Mode Conakry SARL",
    phone: "+224620000011",
    shopKind: "enseigne",
    shopName: "Mode Conakry",
    description: "Enseigne de prêt-à-porter : collections neuves, tailles disponibles en stock, livraison partout à Conakry.",
    coverUrl: "https://images.unsplash.com/photo-1567401893414-76b7b1e5a7a5?w=1200",
    storeAddress: "Avenue de la République, Kaloum",
    neighborhood: "Kaloum",
    landmark: "À côté de la banque centrale",
    openingTime: "09:00",
    closingTime: "20:00",
    zoneName: "Kaloum",
    items: [
      {
        title: "Chemise lin homme",
        net: 150000,
        qty: 25,
        image: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=800",
        description: "Chemise en lin respirant, coupe droite, du S au XXL.",
      },
      {
        title: "Robe midi fleurie",
        net: 210000,
        qty: 18,
        image: "https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=800",
        description: "Robe midi légère à imprimé floral, ceinture assortie.",
      },
      {
        title: "Sneakers blanches",
        net: 320000,
        qty: 30,
        image: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=800",
        description: "Sneakers en cuir blanc, semelle confort, du 36 au 45.",
      },
    ],
  },
];

async function zoneFor(name: string) {
  const existing =
    (await Zone.findOne({ nameFr: name })) ?? (await Zone.findOne());
  if (existing) return existing;
  return Zone.create({ code: name.slice(0, 3).toUpperCase(), nameFr: name, nameEn: name });
}

async function categoryFor(destination: string) {
  return (
    (await Category.findOne({ destination, parentId: { $ne: null } })) ??
    (await Category.findOne({ destination })) ??
    (await Category.findOne())
  );
}

async function main() {
  await connectDb();
  const settings = await getSettings();
  const hash = await bcrypt.hash("Password123!", 10);

  for (const spec of SHOPS) {
    const zone = await zoneFor(spec.zoneName);
    const destination = destinationForSeller("boutique", spec.shopKind)!;
    const category = await categoryFor(destination);

    const seller = {
      kind: "boutique",
      shopKind: spec.shopKind,
      shopName: spec.shopName,
      shopDescription: spec.description,
      bio: spec.description,
      coverUrl: spec.coverUrl,
      verificationStatus: "approved",
      listingDestination: destination,
      storeAddress: spec.storeAddress,
      neighborhood: spec.neighborhood,
      landmark: spec.landmark,
      openingTime: spec.openingTime,
      closingTime: spec.closingTime,
      deliveryDelay: spec.shopKind === "proximite" ? "Retrait le jour même" : "24 à 48 h",
      orangeMoneyPhone: spec.phone,
      shopCreatedAt: new Date(),
      kycDocuments: [
        {
          url: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800",
          mimeType: "image/jpeg",
          name: "registre-commerce.jpg",
          documentType: "business",
          createdAt: new Date(),
        },
      ],
    };

    let user = await User.findOne({ email: spec.email });
    if (user) {
      user.set({ name: spec.name, phone: spec.phone, seller, shippingZoneId: zone._id });
    } else {
      user = new User({
        name: spec.name,
        email: spec.email,
        phone: spec.phone,
        passwordHash: hash,
        authAudience: "CONSUMER",
        canBuy: true,
        emailVerified: true,
        phoneNumberVerified: true,
        shippingZoneId: zone._id,
        seller,
      });
    }
    await user.save();
    await Wallet.findOneAndUpdate({ userId: user._id }, {}, { upsert: true });

    const rate =
      spec.shopKind === "proximite" ? settings.commissionRateProximite : settings.commissionRateStandard;
    await Listing.deleteMany({ sellerId: user._id });
    for (const [i, item] of spec.items.entries()) {
      const priceGnf = previewBuyerPrice(item.net, rate);
      await Listing.create({
        sellerId: user._id,
        categoryId: category?._id ?? null,
        zoneId: zone._id,
        title: item.title,
        description: item.description,
        netPriceGnf: item.net,
        priceGnf,
        commissionRate: rate,
        commissionAmountGnf: priceGnf - item.net,
        quantity: item.qty,
        negotiable: false,
        destination,
        conditionNote: "Neuf",
        status: "ACTIVE",
        publishedAt: new Date(Date.now() - i * 60_000),
        media: [{ storageKey: `seed-shops/${spec.shopKind}/${i}`, url: item.image, mimeType: "image/jpeg", sortOrder: 0 }],
      });
    }

    console.log(`✔ ${spec.shopName} (${spec.shopKind}) — ${spec.items.length} articles · ${spec.email} / Password123!`);
  }

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb().catch(() => {});
  process.exit(1);
});
