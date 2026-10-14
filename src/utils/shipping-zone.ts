import { Zone } from "../models/catalog.js";
import { Listing } from "../models/listing.js";
import { badRequest } from "./http-error.js";

export function isSellerSignupRole(role?: string | null) {
  return !!role && role !== "acheteur";
}

export async function resolveActiveZoneId(zoneId?: string | null) {
  if (!zoneId) return null;
  const zone = await Zone.findOne({ _id: zoneId, isActive: { $ne: false } });
  if (!zone) {
    throw badRequest("INVALID_ZONE", "Zone d’expédition invalide.");
  }
  return zone._id;
}

export async function setUserShippingZone(
  user: { shippingZoneId?: unknown },
  zoneId?: string | null
) {
  const id = await resolveActiveZoneId(zoneId);
  if (!id) {
    throw badRequest(
      "MISSING_SHIPPING_ZONE",
      "Choisis ta zone d’expédition."
    );
  }
  user.shippingZoneId = id;
  return id;
}

export function requireAccountShippingZone(user: { shippingZoneId?: unknown }) {
  if (!user.shippingZoneId) {
    throw badRequest(
      "MISSING_SHIPPING_ZONE",
      "Définis ta zone d’expédition dans ton profil avant de publier."
    );
  }
  return user.shippingZoneId;
}

export async function syncSellerListingZones(
  sellerId: unknown,
  zoneId: unknown
) {
  if (!sellerId || !zoneId) return;
  await Listing.updateMany({ sellerId }, { $set: { zoneId } });
}
