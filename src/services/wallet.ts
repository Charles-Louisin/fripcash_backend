import { Ledger, Wallet } from "../models/commerce.js";

export async function getOrCreateWallet(userId: string) {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) wallet = await Wallet.create({ userId, availableGnf: 0, reservedGnf: 0 });
  return wallet;
}

export async function addLedger(input: {
  userId: string;
  orderId?: string | null;
  type: string;
  amountGnf: number;
  isCredit: boolean;
  label: string;
}) {
  return Ledger.create(input);
}

export async function holdEscrow(sellerId: string, amountGnf: number, orderId: string) {
  const wallet = await getOrCreateWallet(sellerId);
  wallet.reservedGnf += amountGnf;
  await wallet.save();
  await addLedger({
    userId: sellerId,
    orderId,
    type: "escrowHold",
    amountGnf,
    isCredit: false,
    label: "Paiement en séquestre",
  });
}

export async function releaseEscrow(sellerId: string, amountGnf: number, orderId: string) {
  const wallet = await getOrCreateWallet(sellerId);
  wallet.reservedGnf = Math.max(0, wallet.reservedGnf - amountGnf);
  wallet.availableGnf += amountGnf;
  await wallet.save();
  await addLedger({
    userId: sellerId,
    orderId,
    type: "escrowRelease",
    amountGnf,
    isCredit: true,
    label: "Fonds libérés",
  });
}

export async function refundEscrow(
  sellerId: string,
  buyerId: string,
  amountGnf: number,
  orderId: string
) {
  const sellerWallet = await getOrCreateWallet(sellerId);
  sellerWallet.reservedGnf = Math.max(0, sellerWallet.reservedGnf - amountGnf);
  await sellerWallet.save();
  await addLedger({
    userId: sellerId,
    orderId,
    type: "refund",
    amountGnf,
    isCredit: false,
    label: "Remboursement (séquestre)",
  });
  await addLedger({
    userId: buyerId,
    orderId,
    type: "refund_origin",
    amountGnf,
    isCredit: true,
    label: "Remboursement simulé vers le moyen de paiement d'origine",
  });
}
