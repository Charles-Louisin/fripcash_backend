import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export async function connectDb() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongoUri, {
    maxPoolSize: 20,
    minPoolSize: 2,
  });
  logger.info({ uri: env.mongoUri }, "MongoDB connected");
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
