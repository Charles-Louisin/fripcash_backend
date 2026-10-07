import { Resend } from "resend";
import { env, isDev } from "../config/env.js";
import { logger } from "../utils/logger.js";

function client() {
  if (!env.resendApiKey) return null;
  return new Resend(env.resendApiKey);
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  const resend = client();
  if (!resend) {
    if (isDev) {
      logger.warn(
        { to: input.to, subject: input.subject },
        "Resend non configuré — email non envoyé (ajoute RESEND_API_KEY)"
      );
      return { skipped: true as const };
    }
    throw new Error("RESEND_API_KEY manquante");
  }

  const result = await resend.emails.send({
    from: env.resendFrom,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });

  if (result.error) {
    logger.error({ err: result.error, to: input.to }, "Échec envoi Resend");
    throw new Error(result.error.message || "Envoi email impossible");
  }

  logger.info(
    { to: input.to, id: result.data?.id, subject: input.subject },
    "Email Resend envoyé"
  );
  return { skipped: false as const, id: result.data?.id };
}

export function verificationEmailHtml(name: string, code: string) {
  return `
  <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#1c1917">
    <h1 style="font-size:22px;margin:0 0 12px">Confirme ton email</h1>
    <p style="margin:0 0 16px;line-height:1.5">
      Bonjour ${name || ""}, voici ton code FripCash. Il expire dans 15 minutes.
    </p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:24px 0;color:#c2410c">${code}</p>
    <p style="font-size:13px;color:#78716c;margin:0">Si tu n’es pas à l’origine de cette demande, ignore cet email.</p>
  </div>`;
}

export function resetEmailHtml(name: string, link: string) {
  return `
  <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#1c1917">
    <h1 style="font-size:22px;margin:0 0 12px">Réinitialiser le mot de passe</h1>
    <p style="margin:0 0 16px;line-height:1.5">
      Bonjour ${name || ""}, clique le bouton pour choisir un nouveau mot de passe.
    </p>
    <p><a href="${link}" style="display:inline-block;background:#c2410c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600">Nouveau mot de passe</a></p>
    <p style="font-size:13px;color:#78716c">Ce lien expire dans 2 heures.</p>
  </div>`;
}
