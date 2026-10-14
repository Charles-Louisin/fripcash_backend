const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/i;

/** Origin that browsers can reach. Railway injects RAILWAY_PUBLIC_DOMAIN. */
export function publicOrigin(): string {
  const explicit = (process.env.PUBLIC_BASE_URL || process.env.API_PUBLIC_URL || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/\/api\/v1\/?$/, "");
  if (explicit) return explicit;
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railway) {
    const host = railway.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://${host}`;
  }
  return "";
}

/**
 * URL affichable pour une photo.
 * Les hôtes privés et les chemins /uploads deviennent l'origine publique de l'API.
 * Les URL https déjà publiques (UploadThing, Unsplash, Cloudinary) sont gardées.
 */
export function publicMediaUrl(value?: string | null): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const origin = publicOrigin();

  if (raw.startsWith("/uploads/")) {
    return origin ? `${origin}${raw}` : raw;
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const parsed = new URL(raw);
      if (parsed.pathname.startsWith("/uploads/") && PRIVATE_HOST.test(parsed.hostname)) {
        return origin ? `${origin}${parsed.pathname}` : parsed.pathname;
      }
    } catch {
      return raw;
    }
    return raw;
  }

  if (
    !raw.includes(" ") &&
    (raw.startsWith("listings/") || raw.startsWith("categories/") || raw.startsWith("kyc/"))
  ) {
    const path = `/uploads/${raw.replace(/^\//, "")}`;
    return origin ? `${origin}${path}` : path;
  }

  return null;
}

export function mediaUrlsFromListing(listing: {
  media?: Array<{ url?: string | null; storageKey?: string | null; sortOrder?: number }> | null;
} | null | undefined): string[] {
  if (!listing) return [];
  const urls = (listing.media || [])
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((item) => publicMediaUrl(item.url) || publicMediaUrl(item.storageKey))
    .filter((url): url is string => !!url);
  return [...new Set(urls)];
}
