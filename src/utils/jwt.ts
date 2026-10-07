import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { unauthorized } from "./http-error.js";

export type AuthAudience = "CONSUMER" | "ADMIN" | "COURIER";

export type JwtPayload = {
  sub: string;
  aud: AuthAudience;
  email?: string | null;
  phone?: string | null;
};

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.jwtSecret) as JwtPayload;
  } catch {
    throw unauthorized("Session invalide");
  }
}
