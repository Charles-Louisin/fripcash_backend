import { Session } from "../models/auth.js";
import type { AuthAudience } from "../utils/jwt.js";

export async function createSession(input: {
  userId: string;
  token: string;
  audience: AuthAudience;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return Session.create({
    userId: input.userId,
    token: input.token,
    audience: input.audience,
    ipAddress: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    expiresAt,
  });
}

export async function revokeSession(token: string) {
  await Session.deleteOne({ token });
}

export async function revokeAllSessions(userId: string) {
  await Session.deleteMany({ userId });
}
