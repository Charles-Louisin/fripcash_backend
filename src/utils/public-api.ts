import { env } from "../config/env.js";

/** URL publique HTTPS de l'API (webhooks et page de retour du paiement). */
export function publicApiOrigin(): string {
  if (env.publicApiUrl) return env.publicApiUrl.replace(/\/$/, "");
  return `http://127.0.0.1:${env.port}`;
}
