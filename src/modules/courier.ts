import { Router } from "express";
import { z } from "zod";
import { Ledger, Order } from "../models/commerce.js";
import { User } from "../models/user.js";
import { requireAuth, requireAudience, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import { hydrateOrder } from "../services/orders-hydrate.js";
import { addLedger, getOrCreateWallet } from "../services/wallet.js";
import { notifyOrderParties } from "../services/notify.js";
import { courierCoversZone } from "../utils/courier-zones.js";

export const courierRouter = Router();
courierRouter.use(requireAuth, requireAudience("COURIER"));

const PROGRESS: Record<string, string> = {
  COURIER_ASSIGNED: "COLLECTED",
  COLLECTED: "IN_TRANSIT",
  IN_TRANSIT: "DELIVERED",
};

courierRouter.get(
  "/me",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const uid = (req as AuthedRequest).userId!;
    const [mine, wallet] = await Promise.all([
      Order.find({ courierId: uid }).lean(),
      getOrCreateWallet(uid),
    ]);
    const active = mine.filter((o) =>
      ["COURIER_ASSIGNED", "COLLECTED", "IN_TRANSIT"].includes(String(o.status))
    ).length;
    const delivered = mine.filter((o) =>
      ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status))
    ).length;
    res.json({
      id: sid(user._id),
      name: user.name,
      phone: user.phone,
      courier: user.courier,
      stats: {
        active,
        delivered,
        availableGnf: wallet.availableGnf,
      },
    });
  })
);

courierRouter.patch(
  "/me/availability",
  validate(z.object({ isAvailable: z.boolean() })),
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    if (!user.courier) throw forbidden();
    user.courier.isAvailable = req.body.isAvailable;
    await user.save();
    res.json({ isAvailable: user.courier.isAvailable });
  })
);

courierRouter.get(
  "/gains",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const [wallet, entries, delivered] = await Promise.all([
      getOrCreateWallet(uid),
      Ledger.find({ userId: uid }).sort({ createdAt: -1 }).lean(),
      Order.countDocuments({
        courierId: uid,
        status: { $in: ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"] },
      }),
    ]);
    const feeEntries = entries.filter((e) => e.type === "deliveryFee");
    const totalFeesGnf = feeEntries.reduce((s, e) => s + (e.amountGnf || 0), 0);
    res.json({
      availableGnf: wallet.availableGnf,
      reservedGnf: wallet.reservedGnf,
      deliveredCount: delivered,
      totalFeesGnf,
      entries: entries.map((t) => ({
        id: sid(t._id),
        type: t.type,
        amountGnf: t.amountGnf,
        isCredit: t.isCredit,
        label: t.label,
        createdAt: t.createdAt,
      })),
    });
  })
);

courierRouter.get(
  "/missions/open",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const rows = await Order.find({
      fulfillmentMode: "courier",
      status: { $in: ["PREPARING", "READY_FOR_PICKUP"] },
      courierId: null,
    }).sort({ createdAt: -1 });
    const visible = rows.filter((row) =>
      courierCoversZone(user.courier, row.pickupZoneId ? String(row.pickupZoneId) : null)
    );
    res.json(await Promise.all(visible.map(hydrateOrder)));
  })
);

courierRouter.get(
  "/missions",
  ah(async (req, res) => {
    const rows = await Order.find({ courierId: (req as AuthedRequest).userId }).sort({
      createdAt: -1,
    });
    res.json(await Promise.all(rows.map(hydrateOrder)));
  })
);

courierRouter.post(
  "/missions/:orderId/accept",
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    const row = await Order.findById(req.params.orderId);
    if (!row) throw notFound();
    if (!["PREPARING", "READY_FOR_PICKUP"].includes(String(row.status))) {
      throw badRequest("NOT_OPEN", "Cette mission n'est plus disponible");
    }
    if (!courierCoversZone(user.courier, row.pickupZoneId ? String(row.pickupZoneId) : null)) {
      throw forbidden("ZONE", "Cette mission n'est pas dans tes zones");
    }
    if (row.courierId) throw forbidden("TAKEN", "Mission déjà prise");
    row.courierId = user._id as any;
    row.courierName = user.name;
    row.status = "COURIER_ASSIGNED";
    row.timeline.push({ status: "COURIER_ASSIGNED", at: new Date() });
    await row.save();
    await notifyOrderParties(row, "COURIER_ASSIGNED", `${user.name} a accepté la mission`);
    res.json(await hydrateOrder(row));
  })
);

courierRouter.post(
  "/missions/:orderId/progress",
  validate(z.object({ status: z.enum(["COLLECTED", "IN_TRANSIT", "DELIVERED"]) })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.orderId);
    if (!row) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    if (sid(row.courierId) !== uid) throw forbidden();
    const expected = PROGRESS[row.status];
    if (expected !== req.body.status) {
      throw badRequest(
        "ILLEGAL_TRANSITION",
        `Étape suivante attendue : ${expected || "aucune"}`
      );
    }
    row.status = req.body.status;
    row.timeline.push({ status: req.body.status, at: new Date() });
    if (req.body.status === "DELIVERED") {
      const already = await Ledger.findOne({ orderId: row._id, type: "deliveryFee" });
      const fee = Math.max(0, row.shippingCostGnf || 0);
      if (!already && fee > 0) {
        const w = await getOrCreateWallet(uid);
        w.availableGnf += fee;
        await w.save();
        await addLedger({
          userId: uid,
          orderId: sid(row._id),
          type: "deliveryFee",
          amountGnf: fee,
          isCredit: true,
          label: "Frais de livraison",
        });
      }
    }
    await row.save();
    await notifyOrderParties(row, req.body.status);
    res.json(await hydrateOrder(row));
  })
);

courierRouter.post(
  "/missions/:orderId/transfer",
  validate(z.object({ toCourierUserId: z.string() })),
  ah(async (req, res) => {
    const row = await Order.findById(req.params.orderId);
    if (!row) throw notFound();
    if (sid(row.courierId) !== (req as AuthedRequest).userId) throw forbidden();
    const next = await User.findById(req.body.toCourierUserId);
    if (!next || next.authAudience !== "COURIER") throw notFound();
    row.courierId = next._id as any;
    row.courierName = next.name;
    row.timeline.push({
      status: row.status,
      at: new Date(),
      note: `Transfert vers ${next.name}`,
    });
    await row.save();
    res.json(await hydrateOrder(row));
  })
);
