import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { badRequest } from "../utils/http-error.js";

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get(
  "/balance",
  ah(async (_req, res) => {
    res.json({
      balanceGnf: 0,
      availableBalanceGnf: 0,
      reservedBalanceGnf: 0,
      currency: "GNF",
    });
  })
);

walletRouter.get(
  "/ledger",
  ah(async (_req, res) => {
    res.json({ items: [] });
  })
);

walletRouter.post(
  "/withdraw",
  validate(z.object({ amountGnf: z.number().int().min(1), phone: z.string().min(8) })),
  ah(async () => {
    throw badRequest(
      "NO_WALLET",
      "FripCash ne gère pas de portefeuille interne. Les fonds partent directement vers Mobile Money."
    );
  })
);
