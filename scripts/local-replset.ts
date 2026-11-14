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
  // Après un arrêt brutal, mongod rejoue son journal : 10 s (défaut) ne suffisent pas toujours.
  instanceOpts: [{ port: 27027, dbPath, launchTimeout: 90_000 }],
});
console.log(`MongoDB locale prête : ${rs.getUri("fripcash_local")}`);
// Garde le processus actif (une promesse en attente ne suffit pas : Node sortirait en code 13).
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGINT", async () => {
  clearInterval(keepAlive);
  await rs.stop({ doCleanup: false });
  process.exit(0);
});
