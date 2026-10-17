import { Router } from "express";
import { z } from "zod";
import { UTApi } from "uploadthing/server";
import { optionalAuth, type AuthedRequest } from "../middleware/auth.js";
import { unauthorized, badRequest } from "../utils/http-error.js";
import { validate } from "../middleware/validate.js";
import { ah } from "../utils/async-handler.js";
import { env } from "../config/env.js";

export const mediaRouter = Router();

function normalizedType(mimeType: string, filename: string, raw: Buffer) {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const name = filename.toLowerCase();
  const pdfBytes = raw.length >= 5 && raw.subarray(0, 5).toString("latin1") === "%PDF-";
  if (name.endsWith(".pdf") || mime.includes("pdf") || pdfBytes) return "application/pdf";
  if (mime.startsWith("image/")) return mime;
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    name.endsWith(".xls") ||
    name.endsWith(".xlsx")
  ) {
    return mime.startsWith("application/") ? mime : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "";
}

mediaRouter.post(
  "/upload",
  optionalAuth,
  validate(
    z.object({
      filename: z.string().min(1),
      mimeType: z.string().optional(),
      dataBase64: z.string().min(10),
      folder: z.string().optional(),
    })
  ),
  ah(async (req, res) => {
    const folder = (req.body.folder || "listings").replace(/[^a-z]/gi, "");
    const publicFolder = folder === "kyc" || folder === "profile";
    if (!(req as AuthedRequest).userId && !publicFolder) {
      throw unauthorized();
    }
    if (!env.uploadthingToken) {
      throw badRequest("UPLOAD_UNAVAILABLE", "UploadThing n'est pas configuré.");
    }
    const raw = Buffer.from(
      String(req.body.dataBase64).replace(/^data:[^;]+;base64,/, ""),
      "base64"
    );
    if (raw.length > 8 * 1024 * 1024) {
      throw badRequest("FILE_TOO_LARGE", "Fichier trop lourd (8 Mo max).");
    }
    const filename = req.body.filename as string;
    const mimeType = normalizedType((req.body.mimeType as string) || "", filename, raw);
    if (!mimeType) {
      throw badRequest("INVALID_TYPE", "Seules les images, les PDF et les fichiers Excel sont acceptés.");
    }

    const utapi = new UTApi({ token: env.uploadthingToken });
    const storedName = mimeType === "application/pdf" && !filename.toLowerCase().endsWith(".pdf") ? `${filename}.pdf` : filename;
    const file = new File([raw], storedName, { type: mimeType });
    const uploaded = await utapi.uploadFiles(file);
    const data = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    const result = (data as { data?: { ufsUrl?: string; url?: string; key?: string }; error?: { message?: string } })
      ?.data
      ? (data as { data: { ufsUrl?: string; url?: string; key?: string } }).data
      : (data as { ufsUrl?: string; url?: string; key?: string });
    const url = result?.ufsUrl || result?.url;
    if (!url) {
      throw badRequest(
        "UPLOAD_FAILED",
        (data as { error?: { message?: string } })?.error?.message || "UploadThing a échoué"
      );
    }
    res.json({
      publicId: result.key || url,
      url,
      secure_url: url,
      public_id: result.key || url,
    });
  })
);
