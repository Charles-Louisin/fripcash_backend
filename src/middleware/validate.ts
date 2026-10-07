import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

export function validate(schema: ZodSchema, source: "body" | "query" = "body") {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(source === "query" ? req.query : req.body);
      if (source === "query") req.query = parsed as typeof req.query;
      else req.body = parsed;
      next();
    } catch (err) {
      next(err);
    }
  };
}
