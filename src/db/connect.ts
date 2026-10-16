import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export async function connectDb() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongoUri, {
    maxPoolSize: 40,
    minPoolSize: 4,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 5_000,
  });
  logger.info("MongoDB connected");
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
