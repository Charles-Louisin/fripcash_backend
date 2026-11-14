/**
 * Catalogue de DÉMONSTRATION (base privée de test, jamais la base ouverte au public).
 *
 * Crée des boutiques réalistes avec de vraies photos de produits (Unsplash, licence gratuite),
 * des articles par boutique, des clients de démo, des livreurs, des « j'aime », des favoris,
 * des avis et des questions sur les articles, étalés sur plusieurs mois.
 *
 * Tout est marqué (e-mails @demo.fripcash.app) : rien d'autre n'est modifié et tout se retire
 * en une commande. Le nom de la base doit être confirmé explicitement :
 *
 *   npm run seed:demo -- --confirm=<nom de la base>          (ré-exécutable : remplace la démo)
 *   npm run seed:demo -- --confirm=<nom de la base> --remove  (supprime toute la démo)
 *
 * Mot de passe des comptes de démo : variable DEMO_PASSWORD (par défaut celui de scripts/seed.ts).
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../src/db/connect.js";
import { User } from "../src/models/user.js";
import { Category, PlatformSettings, Zone } from "../src/models/catalog.js";
import { Listing } from "../src/models/listing.js";
import { Comment, Favorite, Review, SellerLike } from "../src/models/social.js";
import { previewBuyerPrice } from "../src/utils/pricing.js";

const DEMO_DOMAIN = "demo.fripcash.app";
const DEMO_EMAIL = new RegExp(`@${DEMO_DOMAIN.replace(/\./g, "\\.")}$`);
const DAY = 86_400_000;

// ─── Hasard déterministe : la même démo à chaque exécution ───────────────────────────────
let seed = 20261114;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
function sample<T>(list: readonly T[], n: number) {
  const copy = [...list];
  const out: T[] = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
const daysAgo = (d: number) => new Date(Date.now() - d * DAY - between(0, 20) * 3_600_000);
/** Moment aléatoire entre `from` et maintenant (au moins une heure dans le passé). */
function after(from: unknown) {
  const start = new Date(from as Date).getTime();
  const end = Date.now() - 3_600_000;
  return new Date(start + rand() * Math.max(0, end - start));
}

/** Photo Unsplash optimisée (format automatique, recadrée, ~900 px). */
const photo = (id: string, w = 900) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

// ─── Données ─────────────────────────────────────────────────────────────────────────────
type Product = [title: string, netPriceGnf: number, photoId: string, note?: string];
type Shop = {
  key: string;
  owner: string;
  shopName: string;
  kind: "particulier" | "boutique";
  shopKind: "standard" | "proximite" | "enseigne" | null;
  zone: string;
  neighborhood: string;
  category: string;
  cover: string;
  description: string;
  hours?: [string, string];
  delay: string;
  condition: string;
  products: Product[];
};

const SHOPS: Shop[] = [
  {
    key: "fatou",
    owner: "Fatoumata Bah",
    shopName: "Le Dressing de Fatou",
    kind: "particulier",
    shopKind: null,
    zone: "Z2",
    neighborhood: "Dixinn Port",
    category: "femmes",
    cover: "1769107805465-bfd41863f1a0",
    description: "Je vide mon dressing : robes, sacs et chaussures portés quelques fois, tous en très bon état.",
    delay: "24 à 48 h",
    condition: "Très bon état",
    products: [
      ["Robe blanche en dentelle fleurie", 180_000, "1591221662157-6f62de5508eb", "Taille M, portée une seule fois pour un baptême."],
      ["Robe bustier blanche", 210_000, "1540459920617-415d62f1f76b", "Taille S, coupe ajustée, idéale pour les cérémonies."],
      ["Robe fleurie sans manches", 150_000, "1544586947-3e09d1a036f1", "Taille M, tissu léger parfait pour la chaleur."],
      ["Robe d'été à fleurs bleues", 130_000, "1760097679488-f808c6aca11d", "Taille L, coton, lavée et repassée."],
      ["Top noir sans manches", 60_000, "1519554318711-aaf73ece6ff9", "Taille S, se porte avec un jean ou une jupe."],
      ["Top blanc col rond", 55_000, "1578747522731-9e5a179b02f7", "Taille M, matière fluide."],
      ["Escarpins blancs texturés", 160_000, "1535043934128-cf0b28d52f95", "Pointure 38, talon 9 cm."],
      ["Stilettos blancs en cuir", 175_000, "1562687848-c1664eff566d", "Pointure 39, bout pointu, cuir véritable."],
      ["Sandales à talons noires", 140_000, "1596702874230-b5706dfb5bc7", "Pointure 38, bout ouvert, très confortables."],
      ["Escarpins rouges", 150_000, "1670607231621-c00fd76d2387", "Pointure 37, portés deux fois."],
      ["Sac bandoulière en cuir gris", 220_000, "1559563458-527698bf5295", "Cuir souple, nombreuses poches intérieures."],
      ["Pochette en cuir marron", 120_000, "1579429713897-b98f6afbc295", "Format soirée, fermeture aimantée."],
    ],
  },
  {
    key: "alpha",
    owner: "Alpha Oumar Sow",
    shopName: "Le Vestiaire d'Alpha",
    kind: "particulier",
    shopKind: null,
    zone: "Z1",
    neighborhood: "Kaloum Centre",
    category: "hommes",
    cover: "1729487151777-b4be9098ecbb",
    description: "Vêtements et chaussures homme de qualité, lavés et repassés avant chaque envoi.",
    delay: "24 h",
    condition: "Très bon état",
    products: [
      ["Chemise blanche en coton", 90_000, "1602810318383-e386cc2a3ccf", "Taille L, coupe ajustée, parfaite pour le bureau."],
      ["Chemise bleue boutonnée", 95_000, "1602810316693-3667c854239a", "Taille M, tissu oxford."],
      ["Lot de 3 t-shirts col V", 110_000, "1548768041-2fceab4c0b85", "Noir, gris et marron, taille L."],
      ["Polo bleu", 70_000, "1623658580851-3b25bf83b4ea", "Taille M, piqué de coton."],
      ["Chemise à carreaux rouge et noire", 85_000, "1588795904317-2f4ab1a0a852", "Taille XL, flanelle légère."],
      ["T-shirt blanc col rond", 45_000, "1581655353564-df123a1eb820", "Taille L, 100 % coton."],
      ["Jean bleu brut", 120_000, "1714143136372-ddaf8b606da7", "Taille 32, coupe droite."],
      ["Jean bleu foncé coupe droite", 130_000, "1714143164072-7646ef5cb24d", "Taille 34, très peu porté."],
      ["Jean noir slim", 125_000, "1718252540511-e958742e4165", "Taille 31, stretch."],
      ["Mocassins en cuir marron", 250_000, "1533867617858-e7b97e060509", "Pointure 43, cuir véritable."],
      ["Chaussures à lacets en cuir marron", 270_000, "1614252235316-8c857d38b5f4", "Pointure 42, semelle neuve."],
      ["Derbies noires", 240_000, "1668069226492-508742b03147", "Pointure 44, idéales pour les cérémonies."],
    ],
  },
  {
    key: "sneakers",
    owner: "Mohamed Kaba",
    shopName: "Sneakers Kaloum",
    kind: "particulier",
    shopKind: null,
    zone: "Z1",
    neighborhood: "Almamya",
    category: "hommes",
    cover: "1760302318631-a8d342cd4951",
    description: "Passionné de sneakers : paires authentiques, nettoyées et vérifiées une par une.",
    delay: "24 h",
    condition: "Excellent état",
    products: [
      ["Nike Air Force 1 Low blanc et noir", 450_000, "1587563871167-1ee9c731aefb", "Pointure 42, portées trois fois."],
      ["Air Jordan 1 noir, blanc et rouge", 650_000, "1552346154-21d32810aba3", "Pointure 43, avec la boîte d'origine."],
      ["Air Jordan 1 blanc et noir", 600_000, "1628413993904-94ecb60f1239", "Pointure 41, très bon état."],
      ["Nike Air Max 95 noir et blanc", 520_000, "1550399865-ec7d23b18e8e", "Pointure 44, semelle comme neuve."],
      ["Nike montantes blanches", 480_000, "1512374382149-233c42b6a83b", "Pointure 42, cuir blanc impeccable."],
      ["Adidas blanches et noires", 380_000, "1600054904350-1d493ae5f922", "Pointure 40, confortables au quotidien."],
      ["Nike blanc et rouge", 420_000, "1600185365483-26d7a4cc7519", "Pointure 43, coloris rare."],
      ["Basket blanche perforée", 300_000, "1608231387042-66d1773070a5", "Pointure 41, respirante."],
      ["Baskets running blanc et orange", 350_000, "1600185365926-3a2ce3cdb9eb", "Pointure 42, légères."],
      ["Chaussures de sport blanc et orange, neuves en boîte", 390_000, "1560769629-975ec94e6a86", "Pointure 43, jamais portées."],
    ],
  },
  {
    key: "mariama",
    owner: "Mariama Diallo",
    shopName: "Les Petits Trésors de Mariama",
    kind: "particulier",
    shopKind: null,
    zone: "Z4",
    neighborhood: "Lambanyi",
    category: "enfants",
    cover: "1766918780917-dae0160c3442",
    description: "Vêtements bébé et jouets de mes enfants, propres et en parfait état. Maman de trois !",
    delay: "48 h",
    condition: "Très bon état",
    products: [
      ["Grenouillère bébé blanc et bleu", 45_000, "1622290319146-7b63df48a635", "Taille 3-6 mois."],
      ["Lot de vêtements bébé", 120_000, "1766918780914-5df4a5a98c44", "Six pièces, taille 6-12 mois."],
      ["Panier de vêtements bébé 0-6 mois", 150_000, "1768693602418-260d828b878d", "Bodies, pyjamas et bonnets, panier offert."],
      ["Siège bébé", 350_000, "1522771930-78848d9293e8", "Housse lavable, de la naissance à 9 kg."],
      ["Ours en peluche", 60_000, "1559454403-b8fb88521f11", "Doux et lavable en machine."],
      ["Mobile bébé moutons", 85_000, "1543346242-2b8e41fb91ca", "Se fixe au lit, apaise bébé au coucher."],
      ["Train en bois avec lettres", 95_000, "1769072385024-c962e061c523", "Dès 2 ans, pour apprendre l'alphabet."],
      ["Éléphants en bois", 70_000, "1703581698778-2224c729135b", "Trois figurines peintes à la main."],
      ["Lot de 5 petites voitures", 55_000, "1560859251-d563a49c5e4a", "Voitures de course en métal."],
      ["Panier de blocs de construction", 110_000, "1777351396220-9a3801de44df", "Une centaine de pièces colorées."],
    ],
  },
  {
    key: "tech",
    owner: "Ibrahima Touré",
    shopName: "Conakry Tech",
    kind: "boutique",
    shopKind: "standard",
    zone: "Z1",
    neighborhood: "Avenue de la République",
    category: "telephones",
    cover: "1498049794561-7780e7231661",
    description: "Smartphones, audio et ordinateurs neufs, garantis 6 mois. Facture fournie.",
    hours: ["09:00", "20:00"],
    delay: "24 h",
    condition: "Neuf",
    products: [
      ["iPhone 11 noir 128 Go", 3_900_000, "1571380401583-72ca84994796", "Débloqué tout opérateur, batterie neuve."],
      ["Smartphone Samsung rouge et écouteurs", 2_400_000, "1592899677977-9c10ca588bbd", "Double SIM, 128 Go."],
      ["Smartphone Android argent", 1_500_000, "1480694313141-fce5e697ee25", "Écran 6,5 pouces, 64 Go."],
      ["iPhone 6 gris sidéral reconditionné", 900_000, "1560617544-b4f287789e24", "Reconditionné, garanti 3 mois."],
      ["Casque sans fil noir", 450_000, "1618366712010-f4ae9c647dcb", "Bluetooth, 30 h d'autonomie."],
      ["Casque sans fil rose et blanc", 380_000, "1613040809024-b4ef7ba99bc3", "Pliable, micro intégré."],
      ["Écouteurs sans fil dorés", 950_000, "1545127398-14699f92334b", "Réduction de bruit, étui de charge."],
      ["Casque filaire gris et marron", 250_000, "1484704849700-f032a568e944", "Son studio, prise jack 3,5 mm."],
      ["Apple Watch gris sidéral", 2_800_000, "1546868871-7041f2a55e12", "Bracelet sport noir, 44 mm."],
      ["Montre connectée noire", 450_000, "1624096104992-9b4fa3a279dd", "Suivi du sommeil et des pas."],
      ["Apple Watch argent bracelet blanc", 2_600_000, "1609096458733-95b38583ac4e", "Boîtier aluminium, 40 mm."],
      ["Kit chargeurs et câbles", 120_000, "1573739022854-abceaeb585dc", "Charge rapide USB-C et Lightning."],
      ["Enceinte portable JBL", 750_000, "1608043152269-423dbba4e7e1", "Étanche, 12 h d'autonomie."],
      ["Enceinte Marshall", 2_200_000, "1772442363740-5e746c05b43d", "Son puissant, design vintage."],
      ["MacBook Pro", 14_500_000, "1496181133206-80ce9b88a853", "16 Go de RAM, 512 Go SSD."],
      ["MacBook Air", 11_000_000, "1541807084-5c52b6b3adef", "Léger, 8 Go de RAM, 256 Go SSD."],
    ],
  },
  {
    key: "nene",
    owner: "Néné Camara",
    shopName: "Maison Néné",
    kind: "boutique",
    shopKind: "standard",
    zone: "Z2",
    neighborhood: "Belle-Vue",
    category: "decoration",
    cover: "1740760540616-a3dd85e51352",
    description: "Décoration d'intérieur choisie avec soin : vases, coussins et bougies pour un chez-soi chaleureux.",
    hours: ["10:00", "19:00"],
    delay: "24 à 48 h",
    condition: "Neuf",
    products: [
      ["Trio de vases en argile", 240_000, "1631125915902-d8abe9225ff2", "Faits main, trois tailles."],
      ["Collection de vases en céramique", 320_000, "1597696929736-6d13bed8e6a8", "Tons neutres, lot de cinq."],
      ["Vase en céramique blanc", 95_000, "1612196808214-b8e1d6145a8c", "Hauteur 25 cm, finition mate."],
      ["Cruches en grès", 180_000, "1481401908818-600b7a676c0d", "Lot de trois, style artisanal."],
      ["Petit vase rose à volants", 75_000, "1784901390605-b50174168c40", "Parfait pour une fleur seule."],
      ["Coussin blanc texturé", 85_000, "1629949009765-40fc74c9ec21", "45 × 45 cm, housse amovible."],
      ["Trio de coussins colorés", 210_000, "1553114552-c4ece3a33c93", "Velours doux, trois coloris."],
      ["Coussin marron", 80_000, "1592789705501-f9ae4278a9c9", "Lin naturel, 50 × 50 cm."],
      ["Deux coussins décoratifs", 150_000, "1763694333990-aa6860e6da63", "Pour canapé ou banc."],
      ["Bougie parfumée", 65_000, "1640095889747-2090ee12fa7d", "Vanille et bois de santal, 40 h."],
      ["Bougies blanches à l'eucalyptus", 120_000, "1613068431228-8cb6a1e92573", "Lot de trois, cire naturelle."],
      ["Bougies chauffe-plat", 40_000, "1528351655744-27cc30462816", "Boîte de 50."],
    ],
  },
  {
    key: "cuisine",
    owner: "Kadiatou Barry",
    shopName: "Cuisine & Saveurs",
    kind: "boutique",
    shopKind: "standard",
    zone: "Z3",
    neighborhood: "Matam Marché",
    category: "cuisine",
    cover: "1556910602-38f53e68e15d",
    description: "Tout pour la cuisine : marmites, ustensiles et petit électroménager de qualité.",
    hours: ["08:30", "19:30"],
    delay: "24 h",
    condition: "Neuf",
    products: [
      ["Marmite inox avec couvercle", 260_000, "1693038603562-bb6191269ecc", "10 litres, tous feux dont induction."],
      ["Lot de marmites en inox", 480_000, "1604414499020-f9ac575bc5ec", "Trois tailles, fond épais."],
      ["Casserole émaillée blanche", 180_000, "1518737003272-dac7c4760d5e", "Avec cuillère assortie."],
      ["Cocotte en céramique noire", 220_000, "1629306394113-87a4547af897", "Idéale pour les sauces mijotées."],
      ["Mixeur blender", 450_000, "1654064754916-e3edeb09c042", "1,5 L, six vitesses."],
      ["Bouilloire et mixeur plongeant", 520_000, "1789304140039-8a072a77d343", "Le duo indispensable."],
      ["Ustensiles en bois", 70_000, "1730597363352-0a8fe6eb5d12", "Set de six avec pot de rangement."],
      ["Bols en céramique assortis", 150_000, "1772453609632-2f4aa857f56e", "Lot de six, passent au micro-ondes."],
      ["Vaisselle en céramique bleue", 280_000, "1556910585-09baa3a3998e", "Service de 18 pièces."],
      ["Planche à découper et mug", 90_000, "1452251889946-8ff5ea7b27ab", "Bois massif, mug offert."],
      ["Pichet en verre", 60_000, "1585237672814-8f85a8118bf6", "1,8 L, pour jus et bissap."],
    ],
  },
  {
    key: "beaute",
    owner: "Aïssatou Condé",
    shopName: "Beauté Kankan",
    kind: "boutique",
    shopKind: "standard",
    zone: "Z4",
    neighborhood: "Kipé",
    category: "beaute",
    cover: "1583209814683-c023dd293cc6",
    description: "Parfums, soins et maquillage authentiques. Conseils personnalisés par message.",
    hours: ["10:00", "20:00"],
    delay: "24 h",
    condition: "Neuf",
    products: [
      ["Bleu de Chanel, eau de parfum 100 ml", 1_200_000, "1523293182086-7651a899d37f", "Flacon neuf sous blister."],
      ["Chanel N°5, eau de parfum", 1_400_000, "1541643600914-78b084683601", "100 ml, l'intemporel."],
      ["Parfum oriental noir et or", 650_000, "1594035910387-fea47794261f", "Notes d'oud et d'ambre."],
      ["Parfum frais flacon transparent", 350_000, "1458538977777-0549b2370168", "Agrumes et musc blanc, 50 ml."],
      ["Versace, eau de toilette", 900_000, "1587017539504-67cfbddac569", "100 ml, notes boisées."],
      ["Valentino, eau de Cologne", 1_100_000, "1761329842950-f3551938e4da", "100 ml, élégant et chaud."],
      ["Coffret de soins visage", 450_000, "1580870069867-74c57ee1bb07", "Quatre soins pour une routine complète."],
      ["Sérum en flacon ambré", 180_000, "1608571423902-eed4a5ad8108", "Vitamine C, 30 ml."],
      ["Lot de 4 sérums", 380_000, "1787569499510-ef18cc7ba7a5", "Hydratation, éclat, taches, anti-âge."],
      ["Lotion corporelle", 90_000, "1620916566398-39f1143ab7be", "Beurre de karité, 250 ml."],
      ["Kit de pinceaux maquillage", 150_000, "1596462502278-27bfdc403348", "Douze pinceaux avec trousse."],
      ["Assortiment de maquillage", 260_000, "1631730486572-226d1f595b68", "Rouges à lèvres, fards et poudre."],
    ],
  },
  {
    key: "bijoux",
    owner: "Thierno Diallo",
    shopName: "Bijouterie Diallo",
    kind: "boutique",
    shopKind: "standard",
    zone: "Z1",
    neighborhood: "Marché Niger",
    category: "bijoux-montres",
    cover: "1650455221359-3aebf920bcc5",
    description: "Montres, bijoux en or et lunettes de soleil. Bijouterie familiale depuis 1998.",
    hours: ["09:00", "19:00"],
    delay: "24 h",
    condition: "Neuf",
    products: [
      ["Montre chronographe bracelet cuir", 950_000, "1524805444758-089113d48a6d", "Cadran argenté, cuir marron."],
      ["Montre argent et or", 1_300_000, "1600003014755-ba31aa59c4b6", "Acier bicolore, étanche 50 m."],
      ["Montre argentée cadran noir", 850_000, "1600003014608-c2ccc1570a65", "Classique et sobre."],
      ["Montre cadran blanc", 780_000, "1620625515032-6ed0c1790c75", "Élégante, bracelet acier."],
      ["Chronographe argent et or", 1_500_000, "1587925358603-c2eea5305bbc", "Mouvement automatique."],
      ["Montre de plongée cadran doré", 1_800_000, "1767009951316-c3d2b63179ef", "Lunette tournante, étanche 200 m."],
      ["Créoles torsadées dorées", 350_000, "1617038220319-276d3cfab638", "Plaqué or 18 carats."],
      ["Trio de bracelets en or à breloques", 420_000, "1778000000743-87e855360c51", "Fins et délicats."],
      ["Bracelet chaîne en or", 600_000, "1602173574767-37ac01994b2a", "Maille épaisse, fermoir sécurisé."],
      ["Collier pendentif doré", 480_000, "1569397288884-4d43d6738fbd", "Chaîne 45 cm."],
      ["Trois bagues en or", 900_000, "1631982690223-8aa4be0a2497", "Écrin offert."],
      ["Lunettes de soleil Wayfarer noires", 220_000, "1572635196237-14b3f281503f", "Protection UV400."],
      ["Lunettes de soleil monture blanche", 180_000, "1577803645773-f96470509666", "Verres marron dégradés."],
      ["Lunettes de soleil noires", 150_000, "1584036553516-bf83210aa16c", "Monture légère, étui inclus."],
    ],
  },
  {
    key: "fashion",
    owner: "Sékou Keïta",
    shopName: "Kaloum Fashion Store",
    kind: "boutique",
    shopKind: "standard",
    zone: "Z1",
    neighborhood: "Sandervalia",
    category: "mode-neuve",
    cover: "1765009433753-c7462637d21f",
    description: "Prêt-à-porter neuf homme et femme, arrivages chaque semaine.",
    hours: ["09:30", "20:30"],
    delay: "24 h",
    condition: "Neuf",
    products: [
      ["Jean bleu délavé", 140_000, "1721637286605-ae9be19d681f", "Du 28 au 40, coupe droite."],
      ["Lot de jeans", 380_000, "1637069585336-827b298fe84a", "Trois jeans, coloris assortis."],
      ["T-shirts coton bio, noir et vert", 120_000, "1759572095384-1a7e646d0d4f", "Lot de deux, du S au XXL."],
      ["T-shirt noir et blanc", 65_000, "1618354691438-25bc04584c23", "Col rond, coton épais."],
      ["T-shirt blanc premium", 60_000, "1620799139507-2a76f79a2f4d", "Coton peigné, ne se déforme pas."],
      ["Chemise blanche et violette", 110_000, "1603252110481-7ba873bf42ab", "Coupe slim, repassage facile."],
      ["Vestes de costume", 650_000, "1549037173-e3b717902c57", "Plusieurs coloris, du 46 au 56."],
      ["Sac Prada bleu", 2_500_000, "1685945000440-2b7145b84b9c", "Authentique, carte de garantie."],
      ["Sacoche en cuir gris à boucles dorées", 380_000, "1605733513597-a8f8341084e6", "Format A4."],
      ["Sacs fourre-tout tissés", 160_000, "1524679813234-66a389fe1a42", "Lot de deux, fibres naturelles."],
      ["Talons en velours noir", 420_000, "1770419252709-322eb8d259b4", "Bordure dorée, du 36 au 41."],
      ["Chaussures à talons en cuir noir", 260_000, "1596702876489-9d11e5806161", "Talon 7 cm, du 36 au 41."],
    ],
  },
  {
    key: "superette",
    owner: "Mamadou Saliou Bah",
    shopName: "Supérette Taouyah",
    kind: "boutique",
    shopKind: "proximite",
    zone: "Z4",
    neighborhood: "Taouyah",
    category: "epicerie",
    cover: "1534723452862-4c874018d66d",
    description: "Votre supérette de quartier : riz, café, boissons et produits du quotidien. Retrait en boutique.",
    hours: ["07:30", "22:00"],
    delay: "Le jour même",
    condition: "Neuf",
    products: [
      ["Riz blanc parfumé, sac de 25 kg", 350_000, "1586201375761-83865001e31c", "Riz long grain, récolte récente."],
      ["Riz local, sac de 5 kg", 75_000, "1686820740687-426a7b9b2043", "Riz de Guinée, bien trié."],
      ["Café en grains, 1 kg", 160_000, "1524350876685-274059332603", "Torréfaction moyenne."],
      ["Café en grains, sachet de 500 g", 90_000, "1562051036-e0eea191d42f", "Arabica, notes chocolatées."],
      ["Café de spécialité, 250 g", 85_000, "1512372388054-a322888e67a6", "Pour cafetière ou filtre."],
      ["Assortiment de boissons fraîches", 45_000, "1506617420156-8e4536971650", "Pack de six au choix."],
      ["Panier de courses du quotidien", 120_000, "1543168256-418811576931", "Fruits et conserves, composé chaque matin."],
    ],
  },
  {
    key: "madina",
    owner: "Hawa Sylla",
    shopName: "Fruits & Légumes de Madina",
    kind: "boutique",
    shopKind: "proximite",
    zone: "Z3",
    neighborhood: "Madina",
    category: "fruits-legumes",
    cover: "1488459716781-31db52582fe9",
    description: "Fruits et légumes frais arrivés chaque matin au marché de Madina. Retrait sur place.",
    hours: ["06:30", "19:00"],
    delay: "Le jour même",
    condition: "Frais",
    products: [
      ["Oranges fraîches, le kilo", 15_000, "1769489023737-6d907d807a57", "Juteuses, idéales en jus."],
      ["Panier de fruits exotiques", 120_000, "1619566636858-adf3ef46400b", "Mangue, ananas, kiwi et raisins."],
      ["Bananes et raisins", 35_000, "1631209121750-a9f656d28f46", "Le lot d'environ 2 kg."],
      ["Pommes rouges et poires", 40_000, "1586099529369-00432c0492cd", "Le kilo."],
      ["Tomates fraîches, le panier", 30_000, "1485637701894-09ad422f6de6", "Environ 3 kg."],
      ["Légumes du marché", 45_000, "1591586116988-62fe65164f8d", "Chou-fleur, brocoli, radis et oignons."],
      ["Panier de fruits assortis", 90_000, "1628689469838-524a4a973b8e", "Composé selon l'arrivage."],
      ["Fraises et myrtilles", 60_000, "1580691155297-c6dfa3ca61c4", "Barquette de 500 g."],
    ],
  },
  {
    key: "sport",
    owner: "Ousmane Camara",
    shopName: "Sport Zone Guinée",
    kind: "boutique",
    shopKind: "enseigne",
    zone: "Z2",
    neighborhood: "Dixinn Gare",
    category: "enseignes",
    cover: "1775993699105-4d18bcac7e54",
    description: "L'enseigne du sport à Conakry : football, musculation et chaussures de sport.",
    hours: ["09:00", "21:00"],
    delay: "24 h",
    condition: "Neuf",
    products: [
      ["Ballon de football blanc et bleu", 180_000, "1579952363873-27f3bade9f55", "Taille 5, cousu main."],
      ["Ballon de match Adidas", 250_000, "1486286701208-1d58e9338013", "Taille 5, homologué."],
      ["Ballon de football classique", 120_000, "1543351611-58f69d7c1781", "Noir et blanc, taille 5."],
      ["Paire d'haltères", 220_000, "1703668984128-b506579acdd2", "2 × 5 kg."],
      ["Haltères chromés", 300_000, "1784894645353-81486c66a687", "2 × 8 kg, prise antidérapante."],
      ["Set d'haltères noirs", 260_000, "1638536532686-d610adfc8e5c", "2 × 10 kg."],
      ["Basket de sport blanche, sarcelle et orange", 420_000, "1595341888016-a392ef81b7de", "Du 39 au 46."],
      ["Basket Nike blanche", 450_000, "1695073621086-aa692bc32a3d", "Du 39 au 46."],
    ],
  },
  {
    key: "electro",
    owner: "Fodé Soumah",
    shopName: "ÉlectroPlus Guinée",
    kind: "boutique",
    shopKind: "enseigne",
    zone: "Z5",
    neighborhood: "Matoto Marché",
    category: "enseignes",
    cover: "1571857089849-f6390447191a",
    description: "Téléviseurs, audio et informatique. Livraison et installation dans tout Conakry.",
    hours: ["09:00", "20:00"],
    delay: "24 à 72 h",
    condition: "Neuf",
    products: [
      ["Téléviseur écran plat 55 pouces", 4_500_000, "1593784991251-92ded75ea290", "4K, Smart TV, garantie 1 an."],
      ["Téléviseur 43 pouces", 2_900_000, "1595935736128-db1f0a261263", "Full HD, Smart TV."],
      ["Téléviseur 50 pouces avec meuble", 3_200_000, "1597406462637-eb560874d1f8", "Meuble TV en bois offert."],
      ["Enceinte portable LG", 600_000, "1589256469067-ea99122bbdc4", "Bluetooth, lumières LED."],
      ["Enceinte portable blanche", 420_000, "1582978571763-2d039e56f0c3", "Compacte, 10 h d'autonomie."],
      ["Enceinte connectée HomePod", 2_000_000, "1529359744902-86b2ab9edaea", "Son à 360 degrés."],
      ["MacBook argent", 9_500_000, "1611186871348-b1ce696e52c9", "13 pouces, 256 Go SSD."],
      ["Enceinte portable noire et argent", 380_000, "1589003077984-894e133dabab", "Résistante aux éclaboussures."],
    ],
  },
];

/** Catégories ajoutées pour la démo (créées seulement si absentes). */
const EXTRA_CATEGORIES = [
  { slug: "beaute", nameFr: "Beauté", nameEn: "Beauty", destination: "ARTICLES_NEUFS", parent: null },
  { slug: "bijoux-montres", nameFr: "Bijoux & montres", nameEn: "Jewelry & watches", destination: "ARTICLES_NEUFS", parent: null },
  { slug: "mode-neuve", nameFr: "Mode neuve", nameEn: "New fashion", destination: "ARTICLES_NEUFS", parent: null },
  { slug: "epicerie", nameFr: "Épicerie", nameEn: "Grocery", destination: "QUARTIER_BOUTIQUES", parent: null },
  { slug: "fruits-legumes", nameFr: "Fruits & légumes", nameEn: "Fruits & vegetables", destination: "QUARTIER_BOUTIQUES", parent: "epicerie" },
] as const;

const BUYERS = [
  "Aminata Sylla", "Boubacar Barry", "Kadiatou Diallo", "Mamadou Bah", "Fanta Camara", "Ousmane Diallo",
  "Hadja Soumah", "Abdoulaye Sow", "Mariam Touré", "Lansana Kouyaté", "Djénabou Baldé", "Sékou Condé",
  "Aïcha Keïta", "Moussa Traoré", "Binta Barry", "Ibrahima Sylla", "Oumou Diallo", "Alseny Camara",
  "Saran Kourouma", "Mohamed Lamine Bah", "Nènè Diallo", "Facinet Soumah", "Kadija Cissé", "Thierno Bah",
  "Fatoumata Binta Sow", "Souleymane Kaba", "Mabinty Fofana", "Elhadj Diakité", "Rouguiatou Barry", "Yaya Sangaré",
];

const COURIERS: [string, string, string[]][] = [
  ["Mamady Keïta", "Moto", ["Z1", "Z2"]],
  ["Alhassane Sylla", "Moto", ["Z2", "Z3"]],
  ["Daouda Camara", "Moto", ["Z3", "Z4"]],
  ["Bakary Condé", "Tricycle", ["Z4", "Z5"]],
  ["Sidiki Touré", "Moto", ["Z1", "Z5"]],
  ["Moussa Bangoura", "Voiture", ["Z1", "Z2", "Z3", "Z4", "Z5"]],
  ["Lamine Soumah", "Moto", ["Z4"]],
  ["Ismaël Fofana", "Moto", ["Z3", "Z5"]],
];

const REVIEWS: Record<number, string[]> = {
  5: [
    "Article conforme aux photos, livré en moins de 24 h. Je recommande !",
    "Très satisfaite, la qualité est au rendez-vous. Merci beaucoup !",
    "Vendeur sérieux et très réactif. Je recommanderai sans hésiter.",
    "Parfait, exactement ce que je cherchais. Livraison rapide à Ratoma.",
    "Super qualité pour ce prix, emballage soigné. Merci !",
    "Deuxième commande dans cette boutique, toujours aussi bien.",
    "Le livreur a appelé avant de passer, tout s'est très bien passé.",
    "Produit authentique, je suis ravi de mon achat.",
    "Impeccable du début à la fin. Bravo pour le sérieux !",
    "Très bon contact avec le vendeur, il a répondu à toutes mes questions.",
  ],
  4: [
    "Bon article, conforme à la description. Livraison un peu longue mais ça valait la peine.",
    "Très bien dans l'ensemble, je recommande.",
    "Bonne qualité, juste un peu plus petit que ce que je pensais.",
    "Satisfait de mon achat, vendeur sympathique.",
    "Bon rapport qualité-prix, je repasserai commande.",
  ],
  3: [
    "Correct, mais la livraison a pris deux jours de plus que prévu.",
    "L'article est bien mais la couleur est un peu différente de la photo.",
  ],
};

const QUESTIONS = [
  ["C'est toujours disponible ?", "Oui, toujours disponible ! Vous pouvez commander directement."],
  ["Vous livrez à Kipé ?", "Oui, nous livrons dans tout Conakry, Kipé en 24 h."],
  ["Le prix est négociable ?", "Le prix est déjà bas, mais je fais un geste si vous prenez deux articles."],
  ["Il existe dans une autre taille ?", "Je vérifie le stock et je vous réponds par message."],
  ["Est-ce que c'est l'original ?", "Oui, 100 % authentique, la facture est fournie."],
  ["Je peux venir voir l'article avant d'acheter ?", "Bien sûr, passez à la boutique, nous sommes ouverts tous les jours."],
] as const;

// ─── Exécution ───────────────────────────────────────────────────────────────────────────
function ids<T extends { _id: unknown }>(rows: T[]) {
  return rows.map((r) => r._id);
}

async function removeDemo() {
  const users = await User.find({ email: DEMO_EMAIL }).select("_id").lean();
  const userIds = ids(users);
  const listings = await Listing.find({ sellerId: { $in: userIds } }).select("_id").lean();
  const listingIds = ids(listings);
  const [r1, r2, r3, r4, r5, r6] = await Promise.all([
    Review.deleteMany({ $or: [{ sellerId: { $in: userIds } }, { buyerId: { $in: userIds } }] }),
    Comment.deleteMany({ $or: [{ listingId: { $in: listingIds } }, { userId: { $in: userIds } }] }),
    Favorite.deleteMany({ $or: [{ listingId: { $in: listingIds } }, { userId: { $in: userIds } }] }),
    SellerLike.deleteMany({ $or: [{ sellerId: { $in: userIds } }, { userId: { $in: userIds } }] }),
    Listing.deleteMany({ _id: { $in: listingIds } }),
    User.deleteMany({ _id: { $in: userIds } }),
  ]);
  // Catégories de démo : retirées seulement si plus aucun article ne les utilise.
  let categories = 0;
  for (const c of [...EXTRA_CATEGORIES].reverse()) {
    const cat = await Category.findOne({ slug: c.slug }).lean();
    if (cat && !(await Listing.exists({ categoryId: cat._id })) && !(await Category.exists({ parentId: cat._id }))) {
      await Category.deleteOne({ _id: cat._id });
      categories += 1;
    }
  }
  console.log(
    `Démo supprimée : ${r6.deletedCount} comptes, ${r5.deletedCount} articles, ${r1.deletedCount} avis, ` +
      `${r2.deletedCount} commentaires, ${r3.deletedCount} favoris, ${r4.deletedCount} « j'aime », ${categories} catégories.`
  );
}

async function insertWithDates<T extends mongoose.Model<any>>(Model: T, docs: Record<string, unknown>[]) {
  // Passage par le modèle (valeurs par défaut + validation), puis insertion brute pour garder
  // les dates de création étalées dans le passé (sinon Mongoose les remplace par « maintenant »).
  const rows = docs.map((d) => {
    const doc = new Model(d);
    const err = doc.validateSync();
    if (err) throw err;
    const obj = doc.toObject({ depopulate: true });
    if (d.createdAt) obj.createdAt = d.createdAt;
    obj.updatedAt = d.updatedAt || d.createdAt || new Date();
    return obj;
  });
  if (rows.length) await Model.collection.insertMany(rows);
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.find((a) => a.startsWith("--confirm="))?.split("=")[1];
  await connectDb();
  const dbName = mongoose.connection.db!.databaseName;
  const host = mongoose.connection.host;
  console.log(`Base cible : ${dbName} sur ${host}`);
  if (confirm !== dbName) {
    console.error(`Refusé : relancez avec --confirm=${dbName} pour confirmer la base cible.`);
    await disconnectDb();
    process.exit(1);
  }

  await removeDemo();
  if (args.includes("--remove")) {
    await disconnectDb();
    return;
  }

  const password = process.env.DEMO_PASSWORD || "Password123!";
  const passwordHash = await bcrypt.hash(password, 10);
  const zones = new Map((await Zone.find({}).lean()).map((z) => [z.code, z._id]));
  const settings = await PlatformSettings.findOne({}).lean();
  const rateFor = (shopKind: string | null) =>
    shopKind === "proximite" ? settings?.commissionRateProximite ?? 0.05 : settings?.commissionRateStandard ?? 0.08;

  // Catégories manquantes.
  for (const c of EXTRA_CATEGORIES) {
    if (await Category.exists({ slug: c.slug })) continue;
    const parent = c.parent ? await Category.findOne({ slug: c.parent }).lean() : null;
    await Category.create({ slug: c.slug, nameFr: c.nameFr, nameEn: c.nameEn, destination: c.destination, parentId: parent?._id ?? null, sortOrder: 50 });
  }
  const categories = new Map((await Category.find({}).lean()).map((c) => [c.slug, c._id]));

  let phoneSeq = 0;
  const phone = () => `+2246299${String(10_000 + (phoneSeq += 7)).slice(-5)}`;
  const slug = (name: string) =>
    name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");

  // Clients de démo (comptes anciens : inscrits il y a 1 à 9 mois).
  const buyers = await insertWithDates(
    User,
    BUYERS.map((name, i) => ({
      name,
      email: `${slug(name)}@${DEMO_DOMAIN}`,
      phone: phone(),
      passwordHash,
      emailVerified: true,
      phoneNumberVerified: true,
      authAudience: "CONSUMER",
      shippingZoneId: zones.get(`Z${(i % 5) + 1}`),
      city: "Conakry",
      createdAt: daysAgo(between(30, 270)),
    }))
  );

  // Livreurs validés et disponibles.
  await insertWithDates(
    User,
    COURIERS.map(([name, vehicle, zoneCodes]) => ({
      name,
      email: `${slug(name)}@${DEMO_DOMAIN}`,
      phone: phone(),
      passwordHash,
      emailVerified: true,
      phoneNumberVerified: true,
      authAudience: "COURIER",
      city: "Conakry",
      courier: {
        verificationStatus: "approved",
        isAvailable: rand() > 0.25,
        zoneId: zones.get(zoneCodes[0]),
        zoneIds: zoneCodes.map((z) => zones.get(z)),
        vehicle,
        plate: `RC-${between(1000, 9999)}-${pick(["A", "B", "C", "D"])}`,
      },
      createdAt: daysAgo(between(40, 200)),
    }))
  );

  let listingCount = 0;
  let reviewCount = 0;
  let commentCount = 0;
  let likeCount = 0;
  let favoriteCount = 0;

  for (const shop of SHOPS) {
    const opened = between(75, 260);
    const zoneId = zones.get(shop.zone);
    const destination =
      shop.kind === "particulier"
        ? "SECONDE_MAIN"
        : shop.shopKind === "proximite"
          ? "QUARTIER_BOUTIQUES"
          : shop.shopKind === "enseigne"
            ? "ENSEIGNES"
            : "ARTICLES_NEUFS";
    const likers = sample(buyers, between(8, 26));
    const [seller] = await insertWithDates(User, [
      {
        name: shop.owner,
        email: `${shop.key}@${DEMO_DOMAIN}`,
        phone: phone(),
        passwordHash,
        emailVerified: true,
        phoneNumberVerified: true,
        authAudience: "CONSUMER",
        shippingZoneId: zoneId,
        city: "Conakry",
        avatarUrl: photo(shop.products[0][2], 200),
        bio: shop.description,
        seller: {
          kind: shop.kind,
          shopKind: shop.shopKind,
          shopName: shop.shopName,
          shopDescription: shop.description,
          bio: shop.description,
          coverUrl: photo(shop.cover, 1200),
          likesCount: likers.length,
          shopCreatedAt: daysAgo(opened),
          verificationStatus: shop.kind === "boutique" ? "approved" : "none",
          listingDestination: destination,
          storeAddress: `${shop.neighborhood}, Conakry`,
          neighborhood: shop.neighborhood,
          deliveredCommunes: ["Kaloum", "Dixinn", "Matam", "Ratoma", "Matoto"],
          deliveryDelay: shop.delay,
          openingTime: shop.hours?.[0] ?? "",
          closingTime: shop.hours?.[1] ?? "",
          bundleEnabled: shop.kind === "particulier" && rand() > 0.5,
          bundleMinItems: 2,
          bundleDiscountPercent: 10,
        },
        createdAt: daysAgo(opened + between(3, 20)),
      },
    ]);

    await insertWithDates(
      SellerLike,
      likers.map((b) => ({ userId: b._id, sellerId: seller._id, createdAt: daysAgo(between(1, opened)) }))
    );
    likeCount += likers.length;

    const rate = rateFor(shop.shopKind);
    const categoryId = categories.get(shop.category) ?? null;
    const listingDocs = shop.products.map(([title, net, photoId, note], i) => {
      const age = between(2, opened - 2);
      const priceGnf = previewBuyerPrice(net, rate);
      const promo = shop.kind === "boutique" && i % 4 === 1;
      const soldOut = i % 9 === 8;
      return {
        sellerId: seller._id,
        categoryId,
        zoneId,
        title,
        description: `${note ?? ""} ${shop.kind === "particulier" ? "Envoi soigné, remise en main propre possible." : "Livraison dans tout Conakry."}`.trim(),
        netPriceGnf: net,
        priceGnf,
        commissionRate: rate,
        commissionAmountGnf: priceGnf - net,
        quantity: soldOut ? 0 : shop.kind === "particulier" ? 1 : between(3, 25),
        negotiable: shop.kind === "particulier" && rand() > 0.5,
        pickupEnabled: destination === "SECONDE_MAIN" && rand() > 0.5,
        discountEnabled: promo,
        compareAtPriceGnf: promo ? Math.round((priceGnf * 1.25) / 5_000) * 5_000 : null,
        status: soldOut ? "SOLD_OUT" : "ACTIVE",
        destination,
        conditionNote: shop.condition,
        publishedAt: daysAgo(age),
        media: [{ storageKey: `demo/${shop.key}/${i}`, url: photo(photoId), mimeType: "image/jpeg", sortOrder: 0 }],
        createdAt: daysAgo(age),
      };
    });
    const listings = await insertWithDates(Listing, listingDocs);
    listingCount += listings.length;

    // Avis : la plupart des articles en ont 0 à 3, surtout positifs.
    const reviews: Record<string, unknown>[] = [];
    for (const l of listings) {
      const n = between(0, 3);
      for (const buyer of sample(buyers, n)) {
        const rating = pick([5, 5, 5, 5, 4, 4, 4, 3]);
        reviews.push({
          listingId: l._id,
          sellerId: seller._id,
          buyerId: buyer._id,
          rating,
          comment: pick(REVIEWS[rating]),
          createdAt: after(l.createdAt),
        });
      }
    }
    await insertWithDates(Review, reviews);
    reviewCount += reviews.length;

    // Questions publiques sur quelques articles, avec la réponse du vendeur.
    for (const l of sample(listings, Math.ceil(listings.length / 3))) {
      const [q, a] = pick(QUESTIONS);
      const asked = after(l.createdAt);
      const [question] = await insertWithDates(Comment, [{ listingId: l._id, userId: pick(buyers)._id, body: q, createdAt: asked }]);
      await insertWithDates(Comment, [
        { listingId: l._id, userId: seller._id, body: a, parentId: question._id, createdAt: new Date(Math.min(Date.now() - 600_000, asked.getTime() + between(1, 6) * 3_600_000)) },
      ]);
      commentCount += 2;
    }

    // Favoris.
    const favorites: Record<string, unknown>[] = [];
    for (const l of listings) {
      for (const b of sample(buyers, between(0, 6))) {
        favorites.push({ userId: b._id, listingId: l._id, createdAt: after(l.createdAt) });
      }
    }
    await insertWithDates(Favorite, favorites);
    favoriteCount += favorites.length;
    console.log(`  ✓ ${shop.shopName} : ${listings.length} articles, ${reviews.length} avis, ${likers.length} « j'aime »`);
  }

  console.log(
    `Démo prête : ${SHOPS.length} boutiques, ${listingCount} articles, ${BUYERS.length} clients, ${COURIERS.length} livreurs, ` +
      `${reviewCount} avis, ${commentCount} commentaires, ${likeCount} « j'aime », ${favoriteCount} favoris.`
  );
  console.log(`Connexion : <boutique>@${DEMO_DOMAIN} (ex. tech@${DEMO_DOMAIN}), mot de passe = DEMO_PASSWORD.`);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb().catch(() => {});
  process.exit(1);
});
