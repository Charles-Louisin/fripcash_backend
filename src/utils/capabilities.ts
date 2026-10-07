export type SellerKind = "none" | "particulier" | "boutique";
export type ShopKind = "standard" | "proximite" | "enseigne" | null;
export type VerificationStatus = "none" | "pending" | "approved" | "rejected";

export function computeCapabilities(input: {
  kind?: SellerKind | null;
  shopKind?: ShopKind;
  verificationStatus?: VerificationStatus;
}) {
  const kind = input.kind && input.kind !== "none" ? input.kind : null;
  const shopKind = input.shopKind ?? null;
  const verificationStatus = input.verificationStatus ?? "none";
  const needsReview = shopKind === "proximite" || shopKind === "enseigne";
  const canPublish =
    !!kind &&
    !(needsReview && verificationStatus === "pending") &&
    verificationStatus !== "rejected";

  return {
    createListing: canPublish,
    excelImport: kind === "boutique" && canPublish,
    productLibrary: shopKind === "proximite" && canPublish,
    sellerDashboard: !!kind,
  };
}

export function isDirectoryVisible(input: {
  shopKind?: ShopKind;
  verificationStatus?: VerificationStatus;
}) {
  const shopKind = input.shopKind ?? null;
  const needsReview = shopKind === "proximite" || shopKind === "enseigne";
  if (!needsReview) return true;
  return input.verificationStatus === "approved";
}

export function allowedDestinations(
  kind?: SellerKind | null,
  shopKind?: ShopKind
) {
  if (kind === "particulier") return ["SECONDE_MAIN"];
  if (kind === "boutique") {
    if (shopKind === "proximite") return ["QUARTIER_BOUTIQUES"];
    if (shopKind === "enseigne") return ["ENSEIGNES"];
    return ["ARTICLES_NEUFS"];
  }
  return [];
}
