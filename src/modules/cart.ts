import { Router } from "express";
import { z } from "zod";
import { Cart, Order } from "../models/commerce.js";
import { Listing } from "../models/listing.js";
import { User } from "../models/user.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, notFound } from "../utils/http-error.js";
import { param, sid } from "../utils/ids.js";
import { fulfillmentForShopKind } from "../utils/pricing.js";
import { notifyOrderParties } from "../services/notify.js";
import { DeliveryTariff } from "../models/catalog.js";
import { holdEscrow } from "../services/wallet.js";
import { hydrateOrder } from "../services/orders-hydrate.js";

export const cartRouter = Router();
cartRouter.use(requireAuth, requireAudience("CONSUMER"));

async function loadCart(userId: string) {
  let cart = await Cart.findOne({ userId });
  if (!cart) cart = await Cart.create({ userId, items: [] });
  await cart.populate({
    path: "items.listingId",
    select: "title priceGnf quantity status media",
  });
  return cart;
}

function serializeCart(cart: any) {
  return {
    id: sid(cart._id),
    userId: sid(cart.userId),
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    items: (cart.items || []).map((it: any) => {
      const listing = it.listingId && typeof it.listingId === "object" ? it.listingId : {};
      return {
        id: sid(it._id),
        cartId: sid(cart._id),
        listingId: listing._id ? sid(listing._id) : sid(it.listingId),
        quantity: it.quantity,
        listing: {
          id: listing._id ? sid(listing._id) : sid(it.listingId),
          title: listing.title || "",
          priceGnf: listing.priceGnf || 0,
          quantity: listing.quantity || 0,
          status: listing.status || "ACTIVE",
          media: listing.media || [],
        },
      };
    }),
  };
}

cartRouter.get(
  "/",
  ah(async (req, res) => {
    const cart = await loadCart((req as AuthedRequest).userId!);
    res.json(serializeCart(cart));
  })
);

cartRouter.delete(
  "/",
  ah(async (req, res) => {
    const cart = await Cart.findOneAndUpdate(
      { userId: (req as AuthedRequest).userId },
      { items: [] },
      { new: true, upsert: true }
    );
    res.json(serializeCart(await loadCart(String(cart.userId))));
  })
);

cartRouter.post(
  "/items",
  validate(z.object({ listingId: z.string(), quantity: z.number().int().min(1) })),
  ah(async (req, res) => {
    const listing = await Listing.findById(req.body.listingId);
    if (!listing || listing.status !== "ACTIVE") throw notFound("Article indisponible");
    if (req.body.quantity > listing.quantity) {
      throw badRequest("VALIDATION_ERROR", "Quantité supérieure au stock");
    }
    const cart = await Cart.findOneAndUpdate(
      { userId: (req as AuthedRequest).userId },
      {},
      { upsert: true, new: true }
    );
    const existing = cart.items.find((i) => sid(i.listingId) === req.body.listingId);
    if (existing) existing.quantity = req.body.quantity;
    else cart.items.push({ listingId: req.body.listingId, quantity: req.body.quantity } as any);
    await cart.save();
    res.json(serializeCart(await loadCart(String(cart.userId))));
  })
);

cartRouter.patch(
  "/items/:id",
  validate(z.object({ quantity: z.number().int().min(1) })),
  ah(async (req, res) => {
    const cart = await Cart.findOne({ userId: (req as AuthedRequest).userId });
    if (!cart) throw notFound();
    const item = cart.items.id(param(req.params.id));
    if (!item) throw notFound();
    item.quantity = req.body.quantity;
    await cart.save();
    res.json(serializeCart(await loadCart(String(cart.userId))));
  })
);

cartRouter.delete(
  "/items/:id",
  ah(async (req, res) => {
    const cart = await Cart.findOne({ userId: (req as AuthedRequest).userId });
    if (!cart) throw notFound();
    cart.items.pull({ _id: req.params.id });
    await cart.save();
    res.json(serializeCart(await loadCart(String(cart.userId))));
  })
);

export const checkoutRouter = Router();

checkoutRouter.post(
  "/",
  requireAuth,
  requireAudience("CONSUMER"),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const cart = await Cart.findOne({ userId: user._id });
    if (!cart || cart.items.length === 0) throw badRequest("EMPTY_CART", "Panier vide");

    const merged = new Map<string, { listing: any; quantity: number }>();
    for (const item of cart.items) {
      const listingId = sid(item.listingId);
      const listing = merged.get(listingId)?.listing || (await Listing.findById(item.listingId));
      if (!listing || listing.status !== "ACTIVE") {
        throw badRequest("UNAVAILABLE", "Un article n'est plus disponible");
      }
      const qty = (merged.get(listingId)?.quantity || 0) + item.quantity;
      if (qty > listing.quantity) {
        throw badRequest("VALIDATION_ERROR", `Stock insuffisant: ${listing.title}`);
      }
      merged.set(listingId, { listing, quantity: qty });
    }

    const bySeller = new Map<string, { listing: any; quantity: number }[]>();
    for (const line of merged.values()) {
      const key = sid(line.listing.sellerId);
      const arr = bySeller.get(key) || [];
      arr.push(line);
      bySeller.set(key, arr);
    }

    const body = req.body || {};
    const orders = [];

    async function resolveShipping(fulfillment: string, listing: any) {
      if (fulfillment === "pickup") return 0;
      if (Number(body.shippingCostGnf) > 0) return Number(body.shippingCostGnf);
      const from = listing.zoneId;
      const to = body.toZoneId || body.zoneId;
      if (from && to) {
        const t = await DeliveryTariff.findOne({ fromZoneId: from, toZoneId: to });
        if (t) return t.amountGnf;
      }
      return 0;
    }

    for (const [sellerId, lines] of bySeller) {
      const seller = await User.findById(sellerId);
      const fulfillment =
        body.fulfillmentMode || fulfillmentForShopKind(seller?.seller?.shopKind);
      const items = lines.map(({ listing, quantity }) => ({
        listingId: listing._id,
        title: listing.title,
        quantity,
        priceGnf: listing.priceGnf,
        netPriceGnf: listing.netPriceGnf,
        commissionGnf: listing.commissionAmountGnf * quantity,
      }));
      const originalAmountGnf = items.reduce((s, i) => s + i.priceGnf * i.quantity, 0);
      const commissionGnf = items.reduce((s, i) => s + i.commissionGnf, 0);
      const netTotal = items.reduce((s, i) => s + i.netPriceGnf * i.quantity, 0);
      const shippingCostGnf = await resolveShipping(fulfillment, lines[0].listing);
      const pickupZoneId = lines[0].listing.zoneId || body.toZoneId || body.zoneId || null;
      const negotiable = lines.some((l) => l.listing.negotiable === true);
      const requestedOffer = Number(body.offerAmountGnf);
      const hasOffer =
        negotiable && Number.isFinite(requestedOffer) && requestedOffer > 0;
      const offerAmountGnf = hasOffer ? Math.round(requestedOffer) : null;
      const amountGnf = hasOffer ? offerAmountGnf! : originalAmountGnf;
      const scale = originalAmountGnf > 0 ? amountGnf / originalAmountGnf : 1;
      const escrowNet = Math.round(netTotal * scale);

      const order = await Order.create({
        buyerId: user._id,
        sellerId,
        items,
        amountGnf,
        originalAmountGnf,
        offerAmountGnf,
        offerStatus: hasOffer ? "pending" : "none",
        commissionGnf,
        shippingCostGnf,
        status: "SELLER_NOTIFIED",
        escrowStatus: "held",
        fulfillmentMode: fulfillment,
        paymentMethod: body.paymentMethod || "orange_money",
        pickupCode: null,
        pickupZoneId,
        address: {
          line: body.address,
          city: body.city,
          phone: body.phone,
          name: body.name,
        },
        timeline: [
          { status: "ORDERED", at: new Date() },
          {
            status: "PAID",
            at: new Date(),
            note: hasOffer
              ? `Paiement simulé (offre ${offerAmountGnf} GNF en attente)`
              : "Paiement simulé",
          },
          { status: "SELLER_NOTIFIED", at: new Date() },
        ],
      });

      for (const { listing, quantity } of lines) {
        listing.quantity -= quantity;
        if (listing.quantity <= 0) listing.status = "SOLD_OUT";
        await listing.save();
      }

      await holdEscrow(sellerId, escrowNet, String(order._id));
      await notifyOrderParties(order, "SELLER_NOTIFIED");
      orders.push(await hydrateOrder(order));
    }

    cart.set("items", []);
    await cart.save();

    res.json({
      paymentIntent: { status: "simulated_success" },
      orders,
    });
  })
);
