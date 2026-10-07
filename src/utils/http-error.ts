export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(code: string, message: string) {
  return new HttpError(400, code, message);
}

export function unauthorized(message = "Non authentifié") {
  return new HttpError(401, "UNAUTHORIZED", message);
}

export function forbidden(code = "FORBIDDEN", message = "Accès refusé") {
  return new HttpError(403, code, message);
}

export function notFound(message = "Introuvable") {
  return new HttpError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string) {
  return new HttpError(409, code, message);
}
