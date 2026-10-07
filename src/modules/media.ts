import { Router } from "express";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { z } from "zod";
import { UTApi } from "uploadthing/server";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { env } from "../config/env.js";
import { badRequest } from "../utils/http-error.js";

export const mediaRouter = Router();

mediaRouter.post(
  "/upload",
  requireAuth,
  validate(
    z.object({
      filename: z.string().min(1),
      mimeType: z.string().optional(),
      dataBase64: z.string().min(10),
      folder: z.string().optional(),
    })
  ),
  ah(async (req, res) => {
    const raw = Buffer.from(
      String(req.body.dataBase64).replace(/^data:[^;]+;base64,/, ""),
      "base64"
    );
    const filename = req.body.filename as string;
    const mimeType = (req.body.mimeType as string) || "image/jpeg";

    if (env.uploadthingToken) {
      const utapi = new UTApi({ token: env.uploadthingToken });
      const file = new File([raw], filename, { type: mimeType });
      const uploaded = await utapi.uploadFiles(file);
      const data = Array.isArray(uploaded) ? uploaded[0] : uploaded;
      const result = (data as { data?: { ufsUrl?: string; url?: string; key?: string }; error?: unknown })
        ?.data
        ? (data as { data: { ufsUrl?: string; url?: string; key?: string } }).data
        : (data as { ufsUrl?: string; url?: string; key?: string });
      const url = result?.ufsUrl || result?.url;
      if (url) {
        return res.json({
          publicId: result.key || url,
          url,
          secure_url: url,
          public_id: result.key || url,
        });
      }
      if ((data as { error?: { message?: string } })?.error) {
        throw badRequest(
          "UPLOAD_FAILED",
          (data as { error?: { message?: string } }).error?.message || "UploadThing a échoué"
        );
      }
    }

    const folder = (req.body.folder || "listings").replace(/[^a-z]/gi, "");
    const dir = path.join(process.cwd(), "uploads", folder);
    await mkdir(dir, { recursive: true });
    const ext = path.extname(filename) || ".jpg";
    const name = `${Date.now()}-${randomBytes(6).toString("hex")}${ext}`;
    await writeFile(path.join(dir, name), raw);
    const publicId = `${folder}/${name}`;
    const url = `/uploads/${folder}/${name}`;
    res.json({
      publicId,
      url,
      secure_url: url,
      public_id: publicId,
    });
  })
);
