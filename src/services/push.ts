import { env } from "../config/env.js";
import { PushDevice } from "../models/social.js";
import { logger } from "../utils/logger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN = /^Expo(nent)?PushToken\[.+\]$/;

type Ticket = { status: "ok" | "error"; details?: { error?: string } };

/** Envoie une notification push Expo à tous les appareils enregistrés de l'utilisateur. */
export async function sendPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {}
) {
  const devices = await PushDevice.find({ userId }).lean();
  const tokens = devices.map((d) => d.token).filter((t) => EXPO_TOKEN.test(t));
  if (!tokens.length) return;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (env.expoAccessToken) headers.Authorization = `Bearer ${env.expoAccessToken}`;

  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(
      tokens.map((to) => ({
        to,
        title,
        body: body.slice(0, 180),
        data,
        sound: "default",
        priority: "high",
        channelId: "default",
      }))
    ),
  });
  if (!res.ok) {
    logger.warn({ status: res.status }, "expo push rejected");
    return;
  }
  const json = (await res.json().catch(() => null)) as { data?: Ticket[] } | null;
  const dead = (json?.data || [])
    .map((ticket, i) => (ticket.details?.error === "DeviceNotRegistered" ? tokens[i] : null))
    .filter((t): t is string => !!t);
  if (dead.length) await PushDevice.deleteMany({ userId, token: { $in: dead } });
}
