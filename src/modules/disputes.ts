import { Router } from "express";
import { Dispute } from "../models/ops.js";
import { Order } from "../models/commerce.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, forbidden, notFound } from "../utils/http-error.js";
import { sid } from "../utils/ids.js";
import {
  buyerDisplayName,
  inferSenderRole,
  loadDisputeParties,
  sellerDisplayName,
  serializeDisputeMessage,
} from "../services/dispute-thread.js";

export const disputesRouter = Router();
disputesRouter.use(requireAuth);

async function assertParty(d: any, uid: string, audience?: string) {
  const order = await Order.findById(d.orderId);
  if (!order) throw notFound();
  const isParty = [sid(order.buyerId), sid(order.sellerId)].includes(uid);
  if (!isParty && audience !== "ADMIN") throw forbidden();
  return order;
}

async function serializePartyDispute(d: any, uid: string) {
  const { order, buyer, seller } = await loadDisputeParties(d);
  return {
    id: sid(d._id),
    orderId: sid(d.orderId),
    reason: d.reason,
    status: d.status,
    resolution: d.resolution,
    openerRole: d.openerRole,
    buyerId: order ? sid(order.buyerId) : null,
    sellerId: order ? sid(order.sellerId) : null,
    buyerName: buyerDisplayName(buyer),
    sellerName: sellerDisplayName(seller),
    currentUserId: uid,
    evidence: d.evidence,
    messages: (d.messages || []).map((m: any) =>
      serializeDisputeMessage(m, { order, buyer, seller })
    ),
    createdAt: d.createdAt,
  };
}

disputesRouter.get(
  "/",
  ah(async (req, res) => {
    const uid = (req as AuthedRequest).userId!;
    const orders = await Order.find({ $or: [{ buyerId: uid }, { sellerId: uid }] }).select("_id");
    const rows = await Dispute.find({ orderId: { $in: orders.map((o) => o._id) } })
      .sort({ createdAt: -1 })
      .lean();
    res.json(await Promise.all(rows.map((d) => serializePartyDispute(d, uid))));
  })
);

disputesRouter.post(
  "/:id/evidence",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    await assertParty(d, uid, (req as AuthedRequest).audience);
    d.evidence.push({
      url: req.body.url,
      storageKey: req.body.storageKey || req.body.publicId,
      capturedAt: new Date(),
      uploaderRole: req.body.uploaderRole || "buyer",
    } as any);
    await d.save();
    res.json({ id: sid(d._id), evidence: d.evidence });
  })
);

disputesRouter.post(
  "/:id/messages",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    const order = await Order.findById(d.orderId);
    const uid = (req as AuthedRequest).userId!;
    if (
      order &&
      ![sid(order.buyerId), sid(order.sellerId)].includes(uid) &&
      (req as AuthedRequest).audience !== "ADMIN"
    ) {
      throw forbidden();
    }
    const fromAdmin = (req as AuthedRequest).audience === "ADMIN";
    d.messages.push({
      senderId: uid as any,
      senderRole: fromAdmin ? "admin" : inferSenderRole({ senderId: uid }, order),
      body: req.body.body,
      fromAdmin,
      kind: req.body.kind || "text",
      requestedKinds: req.body.requestedKinds || [],
      attachments: req.body.attachments || [],
      createdAt: new Date(),
    } as any);
    await d.save();
    res.json(await serializePartyDispute(d.toObject(), uid));
  })
);

disputesRouter.post(
  "/:id/close",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    await assertParty(d, uid, (req as AuthedRequest).audience);
    if (d.status === "resolved") {
      throw badRequest("ALREADY_RESOLVED", "Ce litige a déjà été tranché par l'admin.");
    }
    d.status = "closed";
    await d.save();
    res.json({ id: sid(d._id), status: d.status });
  })
);

disputesRouter.post(
  "/:id/reopen",
  ah(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound();
    const uid = (req as AuthedRequest).userId!;
    await assertParty(d, uid, (req as AuthedRequest).audience);
    if (d.status === "resolved") {
      throw badRequest("ALREADY_RESOLVED", "Ce litige a déjà été tranché par l'admin.");
    }
    if (d.status !== "closed") {
      throw badRequest("NOT_CLOSED", "Ce litige n'est pas fermé.");
    }
    d.status = "open";
    await d.save();
    res.json({ id: sid(d._id), status: d.status });
  })
);
