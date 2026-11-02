/**
 * Worker financier autonome (service Railway séparé) : `node dist/worker.js`.
 * Dans ce cas, mettre FINANCE_WORKER_ENABLED=false sur le service API.
 * Plusieurs instances peuvent tourner : verrous et baux MongoDB évitent tout double traitement.
 */
import { assertSecureEnv } from "./config/env.js";
import { connectDb, disconnectDb } from "./db/connect.js";
import { startFinanceWorker } from "./services/finance/worker.js";
import { logger } from "./utils/logger.js";

async function main() {
  assertSecureEnv();
  await connectDb();
  const worker = startFinanceWorker();
  const shutdown = async () => {
    worker.stop();
    await disconnectDb();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Finance worker failed to start");
  process.exit(1);
});
