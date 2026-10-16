import { createApp } from "./app.js";
import { assertSecureEnv, env } from "./config/env.js";
import { connectDb } from "./db/connect.js";
import { logger } from "./utils/logger.js";

async function main() {
  assertSecureEnv();
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, "0.0.0.0", () => {
    logger.info(
      { port: env.port, address: server.address() },
      "FripCash API listening on 0.0.0.0"
    );
    logger.info(
      {
        cinetpayEnv: env.cinetpayEnv,
        cinetpaySource: env.cinetpayEnvSource,
        cinetpayHost: env.cinetpayBaseUrl,
        cinetpayCurrency: env.cinetpayCurrency,
        cinetpayConfigured: Boolean(env.cinetpayAccountKey && env.cinetpayAccountPassword),
      },
      "CinetPay environment"
    );
  });
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
