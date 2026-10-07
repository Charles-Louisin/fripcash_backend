import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDb } from "./db/connect.js";
import { logger } from "./utils/logger.js";

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, "0.0.0.0", () => {
    logger.info(
      { port: env.port, address: server.address() },
      "FripCash API listening on 0.0.0.0"
    );
  });
  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error({ err }, "Failed to start API");
  process.exit(1);
});
