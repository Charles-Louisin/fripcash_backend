import { createApp } from "./app.js";
import { assertSecureEnv, env } from "./config/env.js";
import { connectDb } from "./db/connect.js";
import { logger } from "./utils/logger.js";
import { startFinanceWorker } from "./services/finance/worker.js";

async function main() {
  assertSecureEnv();
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, "0.0.0.0", () => {
    logger.info(
      { port: env.port, address: server.address() },
      "FripCash API listening on 0.0.0.0"
    );
  });

  logger.info(
    {
      chapchapConfigured: Boolean(env.chapchapApiKey && env.chapchapEncryptionKey),
      payoutsConfigured: Boolean(env.chapchapPushAccessCode),
      payoutAutoExecute: env.payoutAutoExecute,
    },
    "Chap Chap Pay"
  );
  const worker = env.financeWorkerEnabled ? startFinanceWorker() : null;
  const shutdown = () => {
    worker?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 50;
  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error({ err }, "Failed to start API");
  process.exit(1);
});
