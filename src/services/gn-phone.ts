export type GnOperator = "OM_GN" | "MTN_GN";

const LOCAL_LEN = 9;
const SUCCESS_SUFFIXES = new Set(["0700", "0701", "0703", "0704", "0706"]);

export function digitsOnly(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

export function gnLocalFromInput(value: string): string | null {
  let digits = digitsOnly(value);
  if (digits.startsWith("00224")) digits = digits.slice(5);
  if (digits.startsWith("224") && digits.length > 9) digits = digits.slice(3);
  if (digits.length !== LOCAL_LEN) return null;
  if (!digits.startsWith("6")) return null;
  return digits;
}

export function operatorFromLocal(local: string): GnOperator | null {
  if (local.startsWith("62")) return "OM_GN";
  if (local.startsWith("65")) return "MTN_GN";
  return null;
}

export function isSandboxTestNumber(local: string): boolean {
  return SUCCESS_SUFFIXES.has(local.slice(-4));
}

export function parseGnMobile(value: string): {
  local: string;
  e164: string;
  operator: GnOperator;
} | null {
  const local = gnLocalFromInput(value);
  if (!local) return null;
  const operator = operatorFromLocal(local);
  if (!operator) return null;
  return { local, e164: `+224${local}`, operator };
}

export function requireGnMobile(
  value: string,
  expected?: GnOperator
): { local: string; e164: string; operator: GnOperator } {
  const parsed = parseGnMobile(value);
  if (!parsed) {
    throw new Error(
      "Numéro guinéen invalide. Utilise un mobile Orange (62) ou MTN (65) à 9 chiffres."
    );
  }
  if (expected && parsed.operator !== expected) {
    const label = expected === "OM_GN" ? "Orange Money (62…)" : "MTN MoMo (65…)";
    throw new Error(`Ce numéro ne correspond pas à ${label}.`);
  }
  return parsed;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

export function splitPersonName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = (parts[0] || "Client").slice(0, 255);
  const last = (parts.slice(1).join(" ") || "FripCash").slice(0, 255);
  return {
    first: first.length >= 2 ? first : `${first}.`,
    last: last.length >= 2 ? last : `${last}.`,
  };
}
