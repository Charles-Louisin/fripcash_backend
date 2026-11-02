/**
 * Frais de paiement Chap Chap Pay répercutés sur le client.
 *
 * L'option « fee_handling: add » n'est pas activée sur le compte marchand : Chap Chap Pay retient
 * donc sa commission sur l'encaissement. FripCash ajoute ces frais au total AVANT le paiement,
 * calculés pour que, une fois la commission retenue, le montant de la commande reste intact.
 * Barème observé sur le compte (transactions réelles) : 2 % + 200 GNF en Mobile Money,
 * 2,5 % + 200 GNF par carte / autres moyens. Configurable par variables d'environnement.
 */
import { env } from "../../config/env.js";

export type FeeChannel = "mobile_money" | "other";

export function feeChannelForMethod(method: string): FeeChannel {
  return method === "OM_GN" || method === "MTN_GN" ? "mobile_money" : "other";
}

function rateFor(channel: FeeChannel) {
  return channel === "mobile_money" ? env.chapchapFeeRateMobile : env.chapchapFeeRateOther;
}

/**
 * Frais à ajouter pour qu'après commission (taux × payé + fixe) il reste au moins `amount`.
 * F = ⌈(taux × montant + fixe) / (1 − taux)⌉
 */
export function paymentFeeGnf(amount: number, method: string) {
  if (!env.chapchapPassFeesToBuyer || amount <= 0) return 0;
  const rate = rateFor(feeChannelForMethod(method));
  if (rate <= 0 && env.chapchapFeeFixedGnf <= 0) return 0;
  return Math.ceil((rate * amount + env.chapchapFeeFixedGnf) / (1 - rate));
}

/** Barème publié à l'app pour afficher les frais avant paiement (le serveur reste la référence). */
export function feeSchedule() {
  return {
    passedToBuyer: env.chapchapPassFeesToBuyer,
    mobileMoneyRate: env.chapchapFeeRateMobile,
    otherRate: env.chapchapFeeRateOther,
    fixedGnf: env.chapchapFeeFixedGnf,
  };
}
