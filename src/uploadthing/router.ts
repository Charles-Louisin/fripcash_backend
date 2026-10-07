import { createUploadthing, type FileRouter } from "uploadthing/express";
import { UploadThingError } from "uploadthing/server";
import { verifyToken } from "../utils/jwt.js";

const f = createUploadthing();

async function requireUploader({
  req,
}: {
  req: { headers: { authorization?: string | string[] } };
}) {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new UploadThingError("Non authentifié");
  try {
    const payload = verifyToken(token);
    return { userId: payload.sub };
  } catch {
    throw new UploadThingError("Session invalide");
  }
}

export const uploadRouter = {
  profileImage: f({ image: { maxFileSize: "4MB", maxFileCount: 1 } })
    .middleware(requireUploader)
    .onUploadComplete(async ({ file }) => ({
      url: file.ufsUrl || file.url,
      key: file.key,
    })),
  listingImage: f({ image: { maxFileSize: "8MB", maxFileCount: 10 } })
    .middleware(requireUploader)
    .onUploadComplete(async ({ file }) => ({
      url: file.ufsUrl || file.url,
      key: file.key,
    })),
  categoryImage: f({ image: { maxFileSize: "4MB", maxFileCount: 1 } })
    .middleware(requireUploader)
    .onUploadComplete(async ({ file }) => ({
      url: file.ufsUrl || file.url,
      key: file.key,
    })),
  kycDocument: f({
    image: { maxFileSize: "8MB", maxFileCount: 4 },
    pdf: { maxFileSize: "8MB", maxFileCount: 4 },
  })
    .middleware(requireUploader)
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl, key: file.key })),
  excelCatalog: f({
    blob: { maxFileSize: "8MB", maxFileCount: 1 },
  })
    .middleware(requireUploader)
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl, key: file.key })),
  disputeFile: f({
    image: { maxFileSize: "8MB", maxFileCount: 8 },
    pdf: { maxFileSize: "8MB", maxFileCount: 8 },
    blob: { maxFileSize: "8MB", maxFileCount: 8 },
  })
    .middleware(requireUploader)
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl, key: file.key })),
} satisfies FileRouter;

export type AppFileRouter = typeof uploadRouter;
