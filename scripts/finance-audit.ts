/**
 * Audit LECTURE SEULE des commandes historiques (avant Chap Chap Pay) : prépare la migration.
 *   npm run finance:audit            → résumé
 *   npm run finance:audit -- --json  → détail complet
 * N'écrit rien en base.
 */
import { connectDb, disconnectDb } from "../src/db/connect.js";
import { Order, Payment } from "../src/models/commerce.js";

type Issue = { orderId: string; kind: string; detail: string };

async function main() {
  await connectDb();
  const legacy = await Order.find({ parentOrderId: null }).lean();
  const issues: Issue[] = [];
  const byEscrow: Record<string, number> = {};
  let heldGnf = 0;

  for (const o of legacy) {
    byEscrow[o.escrowStatus || "?"] = (byEscrow[o.escrowStatus || "?"] || 0) + 1;
    const net = (o.items || []).reduce((s: number, i: any) => s + (i.netPriceGnf || 0) * (i.quantity || 1), 0);
    const id = String(o._id);
    if (net > (o.amountGnf || 0)) issues.push({ orderId: id, kind: "net_above_price", detail: `net ${net} > payé ${o.amountGnf}` });
    if (["held", "payout_pending", "refund_pending"].includes(String(o.escrowStatus))) heldGnf += net;
    if (o.escrowStatus === "payout_pending" && !o.payoutMerchantId) {
      issues.push({ orderId: id, kind: "payout_pending_without_reference", detail: "reversement en attente sans référence de transfert" });
    }
    if (["DELIVERED", "FEEDBACK_PENDING"].includes(String(o.status)) && o.escrowStatus === "held") {
      issues.push({ orderId: id, kind: "delivered_not_released", detail: "livrée mais vendeur non payé" });
    }
    if (o.courierId && (o.shippingCostGnf || 0) > 0 && ["DELIVERED", "FUNDS_RELEASED", "FEEDBACK_PENDING"].includes(String(o.status))) {
      const fee = await Payment.findOne({ orderIds: o._id, kind: "delivery", status: "success" }).lean();
      if (!fee) issues.push({ orderId: id, kind: "courier_fee_not_paid", detail: `${o.shippingCostGnf} GNF non versés au livreur` });
    }
    const inbound = await Payment.find({ orderIds: o._id, kind: "payment", status: "success" }).lean();
    if (inbound.length > 1) issues.push({ orderId: id, kind: "multiple_payments", detail: `${inbound.length} paiements réussis` });
    const payouts = await Payment.find({ orderIds: o._id, kind: "payout", status: "success" }).lean();
    if (payouts.length > 1) issues.push({ orderId: id, kind: "multiple_payouts", detail: `${payouts.length} reversements réussis` });
  }

  const summary = {
    legacyOrders: legacy.length,
    byEscrowStatus: byEscrow,
    stillHeldNetGnf: heldGnf,
    issues: issues.reduce<Record<string, number>>((acc, i) => ((acc[i.kind] = (acc[i.kind] || 0) + 1), acc), {}),
  };
  console.log(JSON.stringify(process.argv.includes("--json") ? { summary, issues } : summary, null, 2));
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
