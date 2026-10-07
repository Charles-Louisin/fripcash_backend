import pino from "pino";
import { isDev } from "../config/env.js";

export const logger = pino({
  level: isDev ? "debug" : "info",
  transport: isDev
    ? { target: "pino/file", options: { destination: 1 } }
    : undefined,
});
