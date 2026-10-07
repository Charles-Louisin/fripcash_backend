export function previewBuyerPrice(netPriceGnf: number, commissionRate: number) {
  return Math.round(netPriceGnf * (1 + commissionRate));
}

export function rateForShopKind(shopKind: string | null | undefined) {
  return shopKind === "proximite" ? 0.05 : 0.08;
}

export function destinationForSeller(
  kind: "none" | "particulier" | "boutique" | null | undefined,
  shopKind: string | null | undefined
) {
  if (kind === "particulier") return "SECONDE_MAIN";
  if (kind !== "boutique") return null;
  if (shopKind === "proximite") return "QUARTIER_BOUTIQUES";
  if (shopKind === "enseigne") return "ENSEIGNES";
  return "ARTICLES_NEUFS";
}

export function fulfillmentForShopKind(shopKind: string | null | undefined) {
  return shopKind === "proximite" ? "pickup" : "courier";
}

export function randomDigits(length: number) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String(Math.floor(Math.random() * 10));
  }
  return out;
}
