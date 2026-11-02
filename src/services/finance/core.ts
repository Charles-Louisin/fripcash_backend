import mongoose, { type ClientSession } from "mongoose";
import { randomBytes } from "crypto";
import { env } from "../../config/env.js";
import {
  FinancialAuditLog,
  FinancialLedgerEntry,
  OutboxEvent,
} from "../../models/finance.js";
import { HttpError } from "../../utils/http-error.js";
import { logger } from "../../utils/logger.js";
import { notifyAdmins } from "../notify.js";

export type Session = ClientSession | null;

export function opts(session: Session) {
  return session ? { session } : {};
}

// ─── Transactions MongoDB ────────────────────────────────────────────────────

let txSupported: boolean | null = null;
let txWarned = false;

export async function transactionsSupported() {
  if (txSupported !== null) return txSupported;
  try {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    txSupported = Boolean(hello.setName || hello.msg === "isdbgrid");
  } catch {
    txSupported = false;
  }
  return txSupported;
}

/**
 * Exécute `fn` dans une transaction MongoDB. Ne JAMAIS appeler le prestataire depuis `fn` :
 * aucune transaction ne reste ouverte pendant un appel HTTP.
 * Sans replica set : refus si FINANCE_REQUIRE_TRANSACTIONS, sinon exécution dégradée
 * (les clés uniques et les mises à jour conditionnelles restent la protection anti-doublon).
 */
export async function withTransaction<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  if (!(await transactionsSupported())) {
    if (env.financeRequireTransactions) {
      throw new HttpError(503, "TX_UNAVAILABLE", "Opérations financières indisponibles : MongoDB doit être un replica set.");
    }
    if (!txWarned) {
      txWarned = true;
      logger.error("MongoDB sans transactions : le système financier tourne en mode dégradé (replica set recommandé).");
    }
    return fn(null);
  }
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// ─── Références ──────────────────────────────────────────────────────────────

export function shortId(value: unknown) {
  return String(value).slice(-8).toUpperCase();
}

export function newOrderNumber(now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `FC-${day}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function money(value: unknown) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, "AMOUNT", "Montant invalide.");
  return n;
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

type LedgerInput = {
  entryKey: string;
  type: string;
  amount: number;
  direction: "in" | "out" | "internal";
  parentOrderId?: unknown;
  sellerOrderId?: unknown;
  paymentId?: unknown;
  allocationId?: unknown;
  payoutId?: unknown;
  attemptId?: unknown;
  refundId?: unknown;
  beneficiaryType?: string;
  beneficiaryId?: unknown;
  reference?: string;
  note?: string;
  currency?: string;
};

/** Écrit une ligne une seule fois (clé métier unique). Rejouer le même traitement est sans effet. */
export async function recordLedger(entry: LedgerInput, session: Session) {
  const doc = {
    ...entry,
    beneficiaryId: entry.beneficiaryId != null ? String(entry.beneficiaryId) : "",
    currency: entry.currency || "GNF",
    occurredAt: new Date(),
  };
  await FinancialLedgerEntry.updateOne(
    { entryKey: entry.entryKey },
    { $setOnInsert: doc },
    { upsert: true, ...opts(session) }
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export type AuditInput = {
  actorId?: unknown;
  actorType: "admin" | "system" | "buyer" | "seller" | "courier" | "provider";
  action: string;
  targetType?: string;
  targetId?: unknown;
  severity?: "info" | "warning" | "critical";
  ip?: string;
  meta?: Record<string, unknown>;
};

export async function auditFinance(entry: AuditInput, session: Session = null) {
  await FinancialAuditLog.create(
    [
      {
        actorId: entry.actorId || null,
        actorType: entry.actorType,
        action: entry.action,
        targetType: entry.targetType || "",
        targetId: entry.targetId != null ? String(entry.targetId) : "",
        severity: entry.severity || "info",
        ip: entry.ip || "",
        meta: entry.meta || {},
      },
    ],
    opts(session)
  );
}

/** Alerte opérationnelle : audit + notification admins. N'échoue jamais. */
export async function alertFinance(title: string, body: string, entry: Omit<AuditInput, "actorType" | "severity"> & { severity?: "warning" | "critical" }) {
  try {
    await auditFinance({ ...entry, actorType: "system", severity: entry.severity || "warning" });
    logger.warn({ action: entry.action, targetId: entry.targetId, meta: entry.meta }, title);
    await notifyAdmins("finance", title, body, { targetId: String(entry.targetId || "") });
  } catch (err) {
    logger.error({ err: String(err) }, "finance alert failed");
  }
}

// ─── Outbox (file persistante) ───────────────────────────────────────────────

export type OutboxType = "payout.execute" | "payout.verify" | "payment.verify" | "batch.refresh";

/** Enregistre une action à exécuter par le worker. Survit aux redémarrages ; dédoublonnée par clé. */
export async function enqueue(
  type: OutboxType,
  payload: Record<string, unknown>,
  dedupeKey: string,
  options: { session?: Session; runAt?: Date; maxAttempts?: number } = {}
) {
  await OutboxEvent.updateOne(
    { dedupeKey },
    {
      $setOnInsert: {
        type,
        payload,
        dedupeKey,
        status: "pending",
        attempts: 0,
        maxAttempts: options.maxAttempts ?? 10,
        nextRunAt: options.runAt || new Date(),
      },
    },
    { upsert: true, ...opts(options.session ?? null) }
  );
}

const OUTBOX_LEASE_MS = 2 * 60_000;

export async function claimOutboxEvent(workerId: string) {
  const now = new Date();
  return OutboxEvent.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextRunAt: { $lte: now } },
        // Worker mort (redémarrage Railway) : l'événement est repris après expiration du bail.
        { status: "processing", lockExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: { status: "processing", lockedBy: workerId, lockExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { nextRunAt: 1 }, new: true }
  );
}

export async function completeOutboxEvent(id: unknown) {
  await OutboxEvent.updateOne(
    { _id: id },
    { $set: { status: "done", processedAt: new Date(), lockedBy: null, lockExpiresAt: null } }
  );
}

/** Replanifie sans compter d'échec (ex. transfert encore en attente chez le prestataire). */
export async function rescheduleOutboxEvent(id: unknown, delayMs: number) {
  await OutboxEvent.updateOne(
    { _id: id },
    {
      $set: { status: "pending", nextRunAt: new Date(Date.now() + delayMs), lockedBy: null, lockExpiresAt: null },
      $inc: { attempts: -1 },
    }
  );
}

export async function failOutboxEvent(event: { _id: unknown; attempts: number; maxAttempts: number; type: string; dedupeKey: string }, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const dead = event.attempts >= event.maxAttempts;
  const backoff = Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, event.attempts - 1));
  await OutboxEvent.updateOne(
    { _id: event._id },
    {
      $set: {
        status: dead ? "dead" : "pending",
        nextRunAt: new Date(Date.now() + backoff),
        lastError: message.slice(0, 1000),
        lockedBy: null,
        lockExpiresAt: null,
      },
    }
  );
  if (dead) {
    await alertFinance("Tâche financière bloquée", `${event.type} a échoué ${event.attempts} fois : ${message}`, {
      action: "outbox.dead",
      targetType: "OutboxEvent",
      targetId: event._id,
      severity: "critical",
      meta: { type: event.type, dedupeKey: event.dedupeKey, error: message },
    });
  }
}
