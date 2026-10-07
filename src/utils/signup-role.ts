import type { User } from "../models/user.js";
import { destinationForSeller } from "./pricing.js";

export const SIGNUP_ROLES = [
  "acheteur",
  "particulier",
  "boutique",
  "commerceLocal",
  "grandeSurface",
] as const;

export type SignupRole = (typeof SIGNUP_ROLES)[number];

export function applySignupRole(
  user: InstanceType<typeof User>,
  role: SignupRole | undefined
) {
  if (!role || role === "acheteur") return user;

  if (role === "particulier") {
    user.seller = {
      kind: "particulier",
      shopKind: null,
      shopName: user.name,
      verificationStatus: "approved",
      listingDestination: "SECONDE_MAIN",
    } as any;
    return user;
  }

  if (role === "boutique") {
    user.seller = {
      kind: "boutique",
      shopKind: "standard",
      shopName: user.name,
      verificationStatus: "approved",
      listingDestination: destinationForSeller("boutique", "standard"),
    } as any;
    return user;
  }

  if (role === "commerceLocal") {
    user.seller = {
      kind: "boutique",
      shopKind: "proximite",
      shopName: user.name,
      verificationStatus: "pending",
      listingDestination: "QUARTIER_BOUTIQUES",
    } as any;
    return user;
  }

  user.seller = {
    kind: "boutique",
    shopKind: "enseigne",
    shopName: user.name,
    verificationStatus: "pending",
    listingDestination: "ENSEIGNES",
  } as any;
  return user;
}

export function audienceForUser(user: InstanceType<typeof User>) {
  if (user.isAdmin) return "ADMIN" as const;
  if (user.authAudience === "COURIER") return "COURIER" as const;
  return "CONSUMER" as const;
}
