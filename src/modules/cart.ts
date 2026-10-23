import { Router } from "express";
import { z } from "zod";
import { Cart, Order, Payment } from "../models/commerce.js";
import { Listing } from "../models/listing.js";
import { User } from "../models/user.js";
import { Offer } from "../models/social.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, notFound } from "../utils/http-error.js";
import { param, sid } from "../utils/ids.js";
import { fulfillmentForShopKind } from "../utils/pricing.js";
import { DeliveryTariff } from "../models/catalog.js";
import { hydrateOrder } from "../services/orders-hydrate.js";
import { publicMediaUrl } from "../utils/public-url.js";
import { isValidEmail, parseGnMobile, splitPersonName } from "../services/gn-phone.js";
import {
  cinetpayNotifyUrl,
  cinetpayReturnUrls,
  initCinetPayPayment,
  isFinalFailure,
  isFinalSuccess,
  throwIfHardFailure,
  type CinetPayMethod,
} from "../services/cinetpay.js";
import {
  MIN_PAYMENT_GNF,
  paymentPublicView,
  restoreReservedStock,
  settleInboundPayment,
} from "../services/payments.js";

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

async function acceptedOffers(buyerId: unknown, listingIds: unknown[]) {
  const rows = await Offer.find({
    buyerId,
    listingId: { $in: listingIds },
    status: "accepted",
    orderId: null,
  })
    .sort({ updatedAt: -1 })
    .lean();
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = sid(row.listingId);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

async function cartView(cart: any) {
  const ids = (cart.items || []).map((it: any) =>
    it.listingId && typeof it.listingId === "object" && it.listingId._id ? it.listingId._id : it.listingId
  );
  return serializeCart(cart, await acceptedOffers(cart.userId, ids));
}

function serializeCart(cart: any, offers = new Map<string, any>()) {
  return {
    id: sid(cart._id),
    userId: sid(cart.userId),
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    items: (cart.items || []).map((it: any) => {
      const listing = it.listingId && typeof it.listingId === "object" ? it.listingId : {};
      const listingId = listing._id ? sid(listing._id) : sid(it.listingId);
      const offer = offers.get(listingId);
      return {
        id: sid(it._id),
        cartId: sid(cart._id),
        listingId,
        quantity: it.quantity,
        acceptedOffer: offer ? { id: sid(offer._id), amountGnf: offer.amountGnf } : null,
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
    res.json(await cartView(cart));
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
    res.json(await cartView(await loadCart(String(cart.userId))));
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
    res.json(await cartView(await loadCart(String(cart.userId))));
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
    const listing = await Listing.findById(item.listingId).select("quantity status").lean();
    if (!listing || listing.status !== "ACTIVE" || listing.quantity <= 0) {
      throw badRequest("SOLD_OUT", "Stock épuisé");
    }
    if (req.body.quantity > listing.quantity) {
      throw badRequest("VALIDATION_ERROR", `Stock insuffisant : ${listing.quantity} disponible(s)`);
    }
    item.quantity = req.body.quantity;
    await cart.save();
    res.json(await cartView(await loadCart(String(cart.userId))));
  })
);

cartRouter.delete(
  "/items/:id",
  ah(async (req, res) => {
    const cart = await Cart.findOne({ userId: (req as AuthedRequest).userId });
    if (!cart) throw notFound();
    cart.items.pull({ _id: req.params.id });
    await cart.save();
    res.json(await cartView(await loadCart(String(cart.userId))));
  })
);

export const checkoutRouter = Router();

const checkoutSchema = z.object({
  fulfillmentMode: z.enum(["courier", "pickup", "shopLocalDelivery"]).optional(),
  paymentMethod: z.enum(["OM_GN", "MTN_GN", "CINETPAY"]),
  address: z.string().min(3),
  city: z.string().optional(),
  phone: z.string().min(8),
  name: z.string().min(2),
  email: z.string().email("Adresse e-mail invalide"),
  mobileNumber: z.string().optional(),
  toZoneId: z.string().optional(),
  zoneId: z.string().optional(),
  offerAmountGnf: z.number().optional(),
});

function bundleDiscountPercent(seller: any, items: { quantity: number }[]) {
  const s = seller?.seller;
  if (!s?.bundleEnabled) return 0;
  const pct = Number(s.bundleDiscountPercent) || 0;
  const count = items.reduce((n, i) => n + i.quantity, 0);
  if (pct <= 0 || count < Math.max(2, Number(s.bundleMinItems) || 2)) return 0;
  return Math.min(90, pct);
}

checkoutRouter.post(
  "/",
  requireAuth,
  requireAudience("CONSUMER"),
  validate(checkoutSchema),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const cart = await Cart.findOne({ userId: user._id });
    if (!cart || cart.items.length === 0) throw badRequest("EMPTY_CART", "Panier vide");

    const body = req.body as z.infer<typeof checkoutSchema>;
    const method = body.paymentMethod as CinetPayMethod;
    const deliveryPhone = parseGnMobile(body.phone);
    if (!deliveryPhone) {
      throw badRequest(
        "PHONE",
        "Le numéro de livraison doit être un mobile guinéen Orange (62) ou MTN (65)."
      );
    }
    if (!isValidEmail(body.email)) {
      throw badRequest("EMAIL", "Adresse e-mail invalide.");
    }

    let payPhone = deliveryPhone;
    if (method === "OM_GN" || method === "MTN_GN") {
      const raw = body.mobileNumber || body.phone;
      const parsed = parseGnMobile(raw);
      if (!parsed) {
        throw badRequest(
          "MOBILE_MONEY",
          "Numéro Mobile Money guinéen invalide (Orange 62 ou MTN 65, 9 chiffres)."
        );
      }
      if (parsed.operator !== method) {
        throw badRequest(
          "OPERATOR",
          method === "OM_GN"
            ? "Ce numéro n'est pas un Orange Money guinéen (préfixe 62)."
            : "Ce numéro n'est pas un MTN MoMo guinéen (préfixe 65)."
        );
      }
      payPhone = parsed;
    }

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

    async function resolveShipping(fulfillment: string, listing: any) {
      if (fulfillment === "pickup") return 0;
      const to = body.toZoneId || body.zoneId;
      if (!to) return 0;
      const from = listing.zoneId;
      if (from) {
        const t = await DeliveryTariff.findOne({ fromZoneId: from, toZoneId: to });
        if (t) return t.amountGnf;
      }
      const same = await DeliveryTariff.findOne({ fromZoneId: to, toZoneId: to });
      if (same) return same.amountGnf;
      const any = await DeliveryTariff.findOne({ toZoneId: to }).sort({ amountGnf: 1 });
      return any?.amountGnf || 0;
    }

    const offers = await acceptedOffers(
      user._id,
      [...merged.values()].map((l) => l.listing._id)
    );
    const requestedOffer = Number(body.offerAmountGnf);
    const wantsGlobalOffer = Number.isFinite(requestedOffer) && requestedOffer > 0;
    if (wantsGlobalOffer && bySeller.size > 1) {
      throw badRequest(
        "OFFER_MULTI_SELLER",
        "Une offre globale n'est possible que pour des articles d'un seul vendeur."
      );
    }

    const sellers = new Map<string, any>();
    for (const sellerId of bySeller.keys()) {
      const seller = await User.findById(sellerId);
      if (seller?.seller?.vacationEnabled) {
        throw badRequest(
          "SELLER_VACATION",
          `${seller.seller.shopName || seller.name || "Ce vendeur"} est en vacances : ses articles ne sont pas commandables pour le moment.`
        );
      }
      sellers.set(sellerId, seller);
    }

    const createdOrders: any[] = [];
    const reservedLines: Array<{ listingId: unknown; quantity: number }> = [];

    try {
      for (const [sellerId, lines] of bySeller) {
        const seller = sellers.get(sellerId);
        const fulfillment =
          body.fulfillmentMode || fulfillmentForShopKind(seller?.seller?.shopKind);
        if (fulfillment === "pickup" && seller?.seller?.shopKind !== "proximite") {
          const handPickupOk = lines.every(
            (l) => l.listing.destination === "SECONDE_MAIN" && l.listing.pickupEnabled === true
          );
          if (!handPickupOk) {
            throw badRequest(
              "PICKUP_NOT_ALLOWED",
              "Le retrait en main propre n'est pas proposé par ce vendeur."
            );
          }
        }
        const usedOffers: any[] = [];
        const items = lines.flatMap(({ listing, quantity }) => {
          const cover = [...(listing.media || [])].sort(
            (a: { sortOrder?: number }, b: { sortOrder?: number }) =>
              (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
          )[0];
          const base = {
            listingId: listing._id,
            title: listing.title,
            imageUrl:
              publicMediaUrl(cover?.url) ||
              publicMediaUrl(cover?.storageKey) ||
              cover?.url ||
              "",
          };
          const full = (qty: number) => ({
            ...base,
            quantity: qty,
            priceGnf: listing.priceGnf,
            netPriceGnf: listing.netPriceGnf,
            commissionGnf: listing.commissionAmountGnf * qty,
          });
          const offer = offers.get(sid(listing._id));
          if (!offer || offer.amountGnf >= listing.priceGnf) return [full(quantity)];
          usedOffers.push(offer);
          const ratio = offer.amountGnf / listing.priceGnf;
          const net = Math.round(listing.netPriceGnf * ratio);
          const offerLine = {
            ...base,
            quantity: 1,
            priceGnf: offer.amountGnf,
            netPriceGnf: net,
            commissionGnf: offer.amountGnf - net,
          };
          return quantity > 1 ? [offerLine, full(quantity - 1)] : [offerLine];
        });
        const originalAmountGnf = lines.reduce(
          (s, l) => s + l.listing.priceGnf * l.quantity,
          0
        );
        const goodsGnf = items.reduce((s, i) => s + i.priceGnf * i.quantity, 0);
        const negotiable = lines.some((l) => l.listing.negotiable === true);
        const hasOffer =
          !usedOffers.length && negotiable && wantsGlobalOffer && requestedOffer < goodsGnf;
        const offerAmountGnf = hasOffer ? Math.round(requestedOffer) : null;
        const bundlePct =
          hasOffer || usedOffers.length ? 0 : bundleDiscountPercent(seller, items);
        const factor = hasOffer ? offerAmountGnf! / goodsGnf : 1 - bundlePct / 100;
        if (factor !== 1) {
          for (const item of items) {
            item.netPriceGnf = Math.round(item.netPriceGnf * factor);
            item.commissionGnf = Math.round(item.commissionGnf * factor);
          }
        }
        const amountGnf = hasOffer ? offerAmountGnf! : Math.round(goodsGnf * factor);
        const commissionGnf = items.reduce((s, i) => s + i.commissionGnf, 0);
        const shippingCostGnf = await resolveShipping(fulfillment, lines[0].listing);
        const pickupZoneId = lines[0].listing.zoneId || body.toZoneId || body.zoneId || null;

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
          status: "ORDERED",
          escrowStatus: "pending",
          fulfillmentMode: fulfillment,
          paymentMethod: method,
          pickupCode: null,
          pickupZoneId,
          address: {
            line: body.address,
            city: body.city,
            zoneId: body.toZoneId || body.zoneId || null,
            phone: deliveryPhone.e164,
            name: body.name,
            email: body.email.trim(),
            paymentPhone: payPhone.e164,
          },
          timeline: [{ status: "ORDERED", at: new Date(), note: "En attente de paiement CinetPay" }],
        });
        createdOrders.push(order);
        if (usedOffers.length) {
          await Offer.updateMany(
            { _id: { $in: usedOffers.map((o) => o._id) } },
            { orderId: order._id }
          );
        }

        for (const { listing, quantity } of lines) {
          listing.quantity -= quantity;
          if (listing.quantity <= 0) listing.status = "SOLD_OUT";
          await listing.save();
          reservedLines.push({ listingId: listing._id, quantity });
        }
      }

      const chargeGnf = createdOrders.reduce(
        (s, o) => s + (o.amountGnf || 0) + (o.shippingCostGnf || 0),
        0
      );
      if (chargeGnf < MIN_PAYMENT_GNF) {
        throw badRequest(
          "MIN_PAYMENT",
          `Le montant minimum de paiement est de ${MIN_PAYMENT_GNF} GNF.`
        );
      }

      const merchantTransactionId = `fc${createdOrders[0]._id.toString()}`.slice(0, 30);
      const names = splitPersonName(body.name);
      const returns = cinetpayReturnUrls(merchantTransactionId);
      const payment = await Payment.create({
        merchantTransactionId,
        kind: "payment",
        status: "pending",
        paymentMethod: method,
        amountGnf: chargeGnf,
        phoneE164: payPhone.e164,
        buyerId: user._id,
        orderIds: createdOrders.map((o) => o._id),
        reservedLines,
      });
      for (const order of createdOrders) {
        order.paymentMerchantId = merchantTransactionId;
        await order.save();
      }

      let result;
      try {
        result = await initCinetPayPayment({
          merchantTransactionId,
          amountGnf: chargeGnf,
          method,
          designation: "Commande FripCash",
          email: body.email.trim(),
          phoneE164: payPhone.e164,
          firstName: names.first,
          lastName: names.last,
          notifyUrl: cinetpayNotifyUrl(),
          successUrl: returns.successUrl,
          failedUrl: returns.failedUrl,
          directPay: false,
        });
      } catch (err) {
        await settleInboundPayment(payment, {
          code: 2010,
          status: "FAILED",
          message: err instanceof Error ? err.message : "Le paiement n'a pas abouti.",
          mustRedirect: false,
          raw: {},
        });
        throw err;
      }
      if (isFinalFailure(result.status) && result.status !== "PENDING" && result.status !== "INITIATED") {
        await settleInboundPayment(payment, result);
        throwIfHardFailure(result);
        throw badRequest(result.status, result.message);
      }
      if (isFinalSuccess(result.status)) {
        await settleInboundPayment(payment, result);
      } else {
        payment.notifyToken = result.notifyToken || payment.notifyToken;
        payment.cinetpayTransactionId = result.transactionId || "";
        payment.paymentUrl = result.paymentUrl || "";
        payment.message = result.message;
        payment.status = "pending";
        await payment.save();
      }

      const fresh = (await Payment.findById(payment._id)) || payment;
      const orders = await Promise.all(
        createdOrders.map(async (o) => {
          const row = await Order.findById(o._id);
          return hydrateOrder(row || o);
        })
      );
      res.json({
        payment: paymentPublicView(fresh, {
          mustRedirect: Boolean(fresh.paymentUrl) || result.mustRedirect,
        }),
        orders,
      });
    } catch (err) {
      const alreadySettled = createdOrders.some(
        (o) => o.status !== "ORDERED" && o.escrowStatus !== "pending"
      );
      if (!alreadySettled && reservedLines.length) {
        const linked = await Payment.findOne({
          orderIds: { $in: createdOrders.map((o) => o._id) },
        });
        if (!linked) {
          await restoreReservedStock(reservedLines);
          await Offer.updateMany(
            { orderId: { $in: createdOrders.map((o) => o._id) } },
            { orderId: null }
          );
          for (const order of createdOrders) {
            if (order.status === "ORDERED") {
              order.status = "REFUNDED";
              order.escrowStatus = "refunded";
              order.timeline.push({
                status: "REFUNDED",
                at: new Date(),
                note: "Paiement non initié",
              });
              await order.save();
            }
          }
        }
      }
      throw err;
    }
  })
);
