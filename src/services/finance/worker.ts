/**
 * Worker financier. Toute la file vit dans MongoDB (outbox) : un redémarrage Railway ne perd
 * aucune tâche et ne rejoue aucun transfert — le verrou atomique du Payout et la vérification
 * des tentatives non tranchées s'en chargent. Les timers ne font que réveiller la boucle.
 */
import os from "os";
import { env } from "../../config/env.js";
import { WorkerLease } from "../../models/finance.js";
import { logger } from "../../utils/logger.js";
import {
  claimOutboxEvent,
  completeOutboxEvent,
  failOutboxEvent,
  rescheduleOutboxEvent,
} from "./core.js";
import { runPaymentVerification } from "./payment-service.js";
import { executePayout, refreshPayoutBatch, verifyPayout, type JobResult } from "./payout-service.js";
import { reconcilePayments, reconcilePayouts, runReconciliation } from "./reconciliation-service.js";

type Handler = (payload: any, workerId: string) => Promise<JobResult | void>;

const handlers: Record<string, Handler> = {
  "payout.execute": (p, w) => executePayout(String(p.payoutId), w),
  "payout.verify": (p) => verifyPayout(String(p.payoutId)),
  "payment.verify": (p) => runPaymentVerification(String(p.paymentId)),
  "batch.refresh": (p) => refreshPayoutBatch(String(p.batchId)),
};

export async function runOutboxEvent(event: any, workerId: string) {
  const handler = handlers[event.type];
  if (!handler) {
    await failOutboxEvent({ ...event.toObject(), attempts: event.maxAttempts }, new Error(`Type inconnu ${event.type}`));
    return;
  }
  try {
    const result = (await handler(event.payload || {}, workerId)) || {};
    if (result.reschedule) await rescheduleOutboxEvent(event._id, result.reschedule);
    else await completeOutboxEvent(event._id);
  } catch (err) {
    logger.warn({ err: String(err), type: event.type, id: String(event._id) }, "finance job failed");
    await failOutboxEvent(event, err);
  }
}

/** Traite la file jusqu'à épuisement (utilisé aussi par les tests). */
export async function drainOutbox(workerId: string, max = 500) {
  let n = 0;
  while (n < max) {
    const event = await claimOutboxEvent(workerId);
    if (!event) break;
    await runOutboxEvent(event, workerId);
    n++;
  }
  return n;
}

/** Bail exclusif pour les tâches périodiques quand plusieurs instances tournent. */
export async function acquireLease(name: string, holder: string, ttlMs: number) {
  const now = new Date();
  try {
    const lease = await WorkerLease.findOneAndUpdate(
      { name, $or: [{ expiresAt: { $lt: now } }, { holder }] },
      { $set: { holder, expiresAt: new Date(now.getTime() + ttlMs), lastRunAt: now } },
      { upsert: true, new: true }
    );
    return lease?.holder === holder;
  } catch {
    return false; // Bail détenu par une autre instance (conflit d'upsert).
  }
}

export function startFinanceWorker(workerId = `${os.hostname()}-${process.pid}`) {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastRecovery = 0;
  let lastReconciliation = 0;

  const tick = async () => {
    try {
      await drainOutbox(workerId, 100);
      const now = Date.now();
      if (now - lastRecovery > 60_000 && (await acquireLease("finance.recovery", workerId, 55_000))) {
        lastRecovery = now;
        await reconcilePayouts();
        await reconcilePayments();
      }
      if (now - lastReconciliation > 15 * 60_000 && (await acquireLease("finance.reconciliation", workerId, 14 * 60_000))) {
        lastReconciliation = now;
        if (env.chapchapApiKey) await runReconciliation();
      }
    } catch (err) {
      logger.error({ err: String(err) }, "finance worker tick failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, env.financeWorkerPollMs);
    }
  };
  timer = setTimeout(tick, 1_000);
  logger.info({ workerId }, "Finance worker started");
  return {
    workerId,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
