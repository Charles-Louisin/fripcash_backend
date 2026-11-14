import type { NextFunction, Request, Response } from "express";

/**
 * Micro-cache mémoire des lectures publiques du catalogue (accueil, explorer, recherche).
 * Lors d'un pic de trafic, des centaines de clients demandent les mêmes listes : une seule
 * requête MongoDB toutes les quelques secondes au lieu d'une par client.
 *
 * Sécurité : seules les réponses 200 à des GET sont gardées, et jamais une réponse qui
 * dépend de l'utilisateur (voir `userIndependent`). Taille bornée, entrées expirées purgées.
 */
type Entry = { body: unknown; expires: number };

const MAX_ENTRIES = 400;
const store = new Map<string, Entry>();

function remember(key: string, body: unknown, ttlMs: number) {
  if (store.size >= MAX_ENTRIES) {
    // Map garde l'ordre d'insertion : on retire la plus ancienne entrée.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { body, expires: Date.now() + ttlMs });
}

export function publicCache(
  ttlMs: number,
  opts: {
    /** La réponse est identique pour tous (connecté ou non) : se met en cache même avec un jeton. */
    userIndependent?: boolean | ((req: Request) => boolean);
  } = {}
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || process.env.PUBLIC_CACHE_DISABLED === "1") return next();
    const independent =
      typeof opts.userIndependent === "function" ? opts.userIndependent(req) : Boolean(opts.userIndependent);
    if (!independent && req.headers.authorization) return next();

    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) {
      res.set("X-Cache", "HIT");
      res.json(hit.body);
      return;
    }
    if (hit) store.delete(key);

    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode === 200) remember(key, body, ttlMs);
      res.set("X-Cache", "MISS");
      return send(body);
    };
    next();
  };
}

/** Pour les tests et après une modification d'admin qui doit se voir immédiatement. */
export function clearPublicCache() {
  store.clear();
}
