import { Router } from "express";
import { z } from "zod";
import { Dispute } from "../models/ops.js";
import { Order } from "../models/commerce.js";
import { Listing } from "../models/listing.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
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
import { resolveDispute, type DisputeActor } from "../services/dispute-resolve.js";
import { notify, notifyAdmins } from "../services/notify.js";

export const disputesRouter = Router();
disputesRouter.use(requireAuth);

function viewerRole(order: any, uid: string, audience?: string): DisputeActor | null {
  if (order && sid(order.buyerId) === uid) return "buyer";
  if (order && sid(order.sellerId) === uid) return "seller";
  if (audience === "ADMIN") return "admin";
  return null;
}

async function loadForViewer(req: AuthedRequest) {
  const d = await Dispute.findById(req.params.id);
  if (!d) throw notFound();
  const order = await Order.findById(d.orderId);
  if (!order) throw notFound();
  const role = viewerRole(order, req.userId!, req.audience);
  if (!role) throw forbidden();
  return { d, order, role };
}

async function serializePartyDispute(d: any, uid: string, audience?: string) {
  const { order, buyer, seller } = await loadDisputeParties(d);
  const listingId = order?.items?.[0]?.listingId;
  const listing = listingId ? await Listing.findById(listingId).select("media").lean() : null;
  const media = (listing as any)?.media?.[0];
  const net = (order?.items || []).reduce(
    (s: number, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1),
    0
  );
  return {
    id: sid(d._id),
    orderId: sid(d.orderId),
    reason: d.reason,
    status: d.status,
    resolution: d.resolution,
    resolvedBy: d.resolvedBy || null,
    buyerPercent: d.buyerPercent ?? null,
    openerRole: d.openerRole,
    buyerId: order ? sid(order.buyerId) : null,
    sellerId: order ? sid(order.sellerId) : null,
    buyerName: buyerDisplayName(buyer),
    sellerName: sellerDisplayName(seller),
    productTitle: order?.items?.[0]?.title || "Article",
    productImage: order?.items?.[0]?.imageUrl || media?.url || media?.storageKey || "",
    amountGnf: order?.amountGnf || 0,
    netGnf: net,
    orderStatus: order?.status,
    escrowStatus: order?.escrowStatus,
    currentUserId: uid,
    viewerRole: viewerRole(order, uid, audience),
    evidence: d.evidence,
    messages: (d.messages || []).map((m: any) =>
      serializeDisputeMessage(m, { order, buyer, seller })
    ),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** Prévient les autres membres du litige (acheteur, vendeur, admins) sauf l'auteur. */
async function notifyThread(order: any, d: any, actorId: string, title: string, body: string) {
  const data = { disputeId: sid(d._id), orderId: sid(order._id) };
  for (const uid of [sid(order.buyerId), sid(order.sellerId)]) {
    if (uid !== actorId) await notify(uid, "dispute", title, body, data);
  }
  await notifyAdmins("dispute", title, body, data, actorId);
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

disputesRouter.get(
  "/:id",
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d } = await loadForViewer(r);
    res.json(await serializePartyDispute(d.toObject(), r.userId!, r.audience));
  })
);

disputesRouter.post(
  "/:id/evidence",
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d, role } = await loadForViewer(r);
    d.evidence.push({
      url: req.body.url,
      storageKey: req.body.storageKey || req.body.publicId,
      capturedAt: new Date(),
      uploaderRole: role,
    } as any);
    await d.save();
    res.json({ id: sid(d._id), evidence: d.evidence });
  })
);

const attachmentSchema = z.object({
  url: z.string().min(1),
  storageKey: z.string().optional(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
});

disputesRouter.post(
  "/:id/messages",
  validate(
    z
      .object({
        body: z.string().max(4000).optional().default(""),
        kind: z.enum(["text", "info_request", "info_response"]).optional(),
        attachments: z.array(attachmentSchema).max(10).optional().default([]),
      })
      .refine((v) => v.body.trim() || v.attachments.length, {
        message: "Message vide",
      })
  ),
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d, order, role } = await loadForViewer(r);
    if (d.status === "resolved") {
      throw badRequest("ALREADY_RESOLVED", "Ce litige a déjà été tranché.");
    }
    const fromAdmin = role === "admin";
    const body = String(req.body.body || "").trim();
    d.messages.push({
      senderId: r.userId as any,
      senderRole: fromAdmin ? "admin" : inferSenderRole({ senderId: r.userId }, order),
      body,
      fromAdmin,
      kind: req.body.kind || "text",
      requestedKinds: [],
      attachments: req.body.attachments,
      createdAt: new Date(),
    } as any);
    if (d.status === "closed") d.status = "open";
    await d.save();

    const { buyer, seller } = await loadDisputeParties(d.toObject());
    const who =
      role === "admin" ? "Équipe FripCash" : role === "seller" ? sellerDisplayName(seller) : buyerDisplayName(buyer);
    const files = req.body.attachments.length;
    const preview = body || (files > 1 ? `${files} pièces jointes` : "Pièce jointe");
    await notifyThread(order, d, r.userId!, `Litige · ${who}`, preview);

    res.json(await serializePartyDispute(d.toObject(), r.userId!, r.audience));
  })
);

disputesRouter.post(
  "/:id/release",
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d, order, role } = await loadForViewer(r);
    if (role === "seller") throw forbidden("FORBIDDEN", "Seul l'acheteur ou l'admin peut payer le vendeur.");
    await resolveDispute(d, order, "release_seller", { actor: role, actorId: r.userId! });
    res.json(await serializePartyDispute(d.toObject(), r.userId!, r.audience));
  })
);

disputesRouter.post(
  "/:id/refund",
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d, order, role } = await loadForViewer(r);
    if (role === "buyer") throw forbidden("FORBIDDEN", "Seul le vendeur ou l'admin peut rembourser l'acheteur.");
    await resolveDispute(d, order, "refund_buyer", { actor: role, actorId: r.userId! });
    res.json(await serializePartyDispute(d.toObject(), r.userId!, r.audience));
  })
);

disputesRouter.post(
  "/:id/split",
  validate(z.object({ buyerPercent: z.number().min(0).max(100), note: z.string().optional() })),
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d, order, role } = await loadForViewer(r);
    if (role !== "admin") throw forbidden("FORBIDDEN", "Seul l'admin peut partager le montant.");
    await resolveDispute(d, order, "partial_refund", {
      actor: "admin",
      actorId: r.userId!,
      buyerPercent: req.body.buyerPercent,
      note: req.body.note,
    });
    res.json(await serializePartyDispute(d.toObject(), r.userId!, r.audience));
  })
);

disputesRouter.post(
  "/:id/close",
  ah(async (req, res) => {
    const r = req as AuthedRequest;
    const { d } = await loadForViewer(r);
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
    const r = req as AuthedRequest;
    const { d } = await loadForViewer(r);
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
