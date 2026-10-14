import { Router } from "express";
import { z } from "zod";
import { Cart, Order, Payment } from "../models/commerce.js";
import { Listing } from "../models/listing.js";
import { User } from "../models/user.js";
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

const checkoutSchema = z.object({
  fulfillmentMode: z.enum(["courier", "pickup", "shopLocalDelivery"]).optional(),
  paymentMethod: z.enum(["OM_GN", "MTN_GN", "CINETPAY"]),
  address: z.string().min(3),
  city: z.string().optional(),
  phone: z.string().min(8),
  name: z.string().min(2),
  email: z.string().email("Adresse e-mail invalide"),
  mobileNumber: z.string().optional(),
  shippingCostGnf: z.number().optional(),
  toZoneId: z.string().optional(),
  zoneId: z.string().optional(),
  offerAmountGnf: z.number().optional(),
});

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
      if (Number(body.shippingCostGnf) > 0) return Number(body.shippingCostGnf);
      const from = listing.zoneId;
      const to = body.toZoneId || body.zoneId;
      if (from && to) {
        const t = await DeliveryTariff.findOne({ fromZoneId: from, toZoneId: to });
        if (t) return t.amountGnf;
      }
      return 0;
    }

    const createdOrders: any[] = [];
    const reservedLines: Array<{ listingId: unknown; quantity: number }> = [];
    let shippingAssigned = false;

    try {
      for (const [sellerId, lines] of bySeller) {
        const seller = await User.findById(sellerId);
        const fulfillment =
          body.fulfillmentMode || fulfillmentForShopKind(seller?.seller?.shopKind);
        const items = lines.map(({ listing, quantity }) => {
          const cover = [...(listing.media || [])].sort(
            (a: { sortOrder?: number }, b: { sortOrder?: number }) =>
              (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
          )[0];
          return {
            listingId: listing._id,
            title: listing.title,
            quantity,
            priceGnf: listing.priceGnf,
            netPriceGnf: listing.netPriceGnf,
            commissionGnf: listing.commissionAmountGnf * quantity,
            imageUrl:
              publicMediaUrl(cover?.url) ||
              publicMediaUrl(cover?.storageKey) ||
              cover?.url ||
              "",
          };
        });
        const originalAmountGnf = items.reduce((s, i) => s + i.priceGnf * i.quantity, 0);
        const commissionGnf = items.reduce((s, i) => s + i.commissionGnf, 0);
        const negotiable = lines.some((l) => l.listing.negotiable === true);
        const requestedOffer = Number(body.offerAmountGnf);
        const hasOffer =
          negotiable && Number.isFinite(requestedOffer) && requestedOffer > 0;
        const offerAmountGnf = hasOffer ? Math.round(requestedOffer) : null;
        const amountGnf = hasOffer ? offerAmountGnf! : originalAmountGnf;
        const shippingCostGnf = shippingAssigned
          ? 0
          : await resolveShipping(fulfillment, lines[0].listing);
        shippingAssigned = true;
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
            phone: deliveryPhone.e164,
            name: body.name,
            email: body.email.trim(),
            paymentPhone: payPhone.e164,
          },
          timeline: [{ status: "ORDERED", at: new Date(), note: "En attente de paiement CinetPay" }],
        });
        createdOrders.push(order);

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
