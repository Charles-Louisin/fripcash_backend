/**
 * MongoDB locale en replica set (transactions) pour tester le serveur sans toucher Atlas :
 *   npm run db:local        → mongodb://127.0.0.1:27027/fripcash_local?replicaSet=rs0
 */
import { mkdirSync } from "fs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const dbPath = process.env.LOCAL_DB_PATH || ".local-mongo";
mkdirSync(dbPath, { recursive: true });
const rs = await MongoMemoryReplSet.create({
  replSet: { name: "rs0", count: 1, storageEngine: "wiredTiger" },
  instanceOpts: [{ port: 27027, dbPath }],
});
console.log(`MongoDB locale prête : ${rs.getUri("fripcash_local")}`);
process.on("SIGINT", async () => {
  await rs.stop({ doCleanup: false });
  process.exit(0);
});
await new Promise(() => {});
