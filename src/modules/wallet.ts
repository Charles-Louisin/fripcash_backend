import { Router } from "express";
import { z } from "zod";
import { Ledger } from "../models/commerce.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest } from "../utils/http-error.js";
import { addLedger, getOrCreateWallet } from "../services/wallet.js";
import { getSettings } from "../services/notify.js";
import { sid } from "../utils/ids.js";

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get(
  "/balance",
  ah(async (req, res) => {
    const w = await getOrCreateWallet((req as AuthedRequest).userId!);
    res.json({
      balanceGnf: w.availableGnf + w.reservedGnf,
      availableBalanceGnf: w.availableGnf,
      reservedBalanceGnf: w.reservedGnf,
      currency: "GNF",
    });
  })
);

walletRouter.get(
  "/ledger",
  ah(async (req, res) => {
    const rows = await Ledger.find({ userId: (req as AuthedRequest).userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      items: rows.map((t) => ({
        id: sid(t._id),
        type: t.type,
        amountGnf: t.amountGnf,
        isCredit: t.isCredit,
        label: t.label,
        createdAt: t.createdAt,
      })),
    });
  })
);

walletRouter.post(
  "/withdraw",
  validate(z.object({ amountGnf: z.number().int().min(1) })),
  ah(async (req, res) => {
    const settings = await getSettings();
    if (req.body.amountGnf < (settings.minWithdrawalGnf || 1)) {
      throw badRequest("MIN_WITHDRAWAL", "Montant inférieur au minimum");
    }
    const w = await getOrCreateWallet((req as AuthedRequest).userId!);
    if (w.availableGnf < req.body.amountGnf) {
      throw badRequest("INSUFFICIENT", "Solde insuffisant");
    }
    w.availableGnf -= req.body.amountGnf;
    await w.save();
    await addLedger({
      userId: (req as AuthedRequest).userId!,
      type: "withdrawal",
      amountGnf: req.body.amountGnf,
      isCredit: false,
      label: "Retrait simulé Orange Money",
    });
    res.json({ status: "simulated_success", amountGnf: req.body.amountGnf });
  })
);
