import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { randomBytes } from "crypto";
import { AuthToken, OtpCode } from "../models/auth.js";
import { User } from "../models/user.js";
import { env, isDev } from "../config/env.js";
import { ah } from "../utils/async-handler.js";
import { badRequest, unauthorized, forbidden } from "../utils/http-error.js";
import { signToken, verifyToken, type AuthAudience } from "../utils/jwt.js";
import { randomDigits } from "../utils/pricing.js";
import { toAuthUser, toMe } from "../serializers.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createSession, revokeAllSessions, revokeSession } from "../services/session.js";
import { getOrCreateWallet } from "../services/wallet.js";
import {
  sendEmail,
  verificationEmailHtml,
  resetEmailHtml,
} from "../services/mail.js";
import { logger } from "../utils/logger.js";
import {
  applySignupRole,
  audienceForUser,
  SIGNUP_ROLES,
} from "../utils/signup-role.js";

const passwordSchema = z
  .string()
  .min(8, "8 caractères minimum")
  .max(128, "Mot de passe trop long")
  .regex(/[A-Za-zÀ-ÿ]/, "Ajoute au moins une lettre")
  .regex(/[0-9]/, "Ajoute au moins un chiffre");

export const authRouter = Router();

function bearer(req: AuthedRequest) {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

async function issue(
  req: AuthedRequest,
  user: InstanceType<typeof User>,
  audience: AuthAudience
) {
  const token = signToken({
    sub: String(user._id),
    aud: audience,
    email: user.email,
    phone: user.phone,
  });
  await createSession({
    userId: String(user._id),
    token,
    audience,
    ip: req.ip,
    userAgent: req.header("user-agent"),
  });
  await getOrCreateWallet(String(user._id));
  return token;
}

async function issueEmailVerificationCode(
  user: InstanceType<typeof User>
) {
  if (!user.email || user.emailVerified) return null;
  const code = isDev && env.otpDevEcho ? "000000" : randomDigits(6);
  await AuthToken.deleteMany({ userId: user._id, kind: "email_verify" });
  await AuthToken.create({
    userId: user._id,
    token: code,
    kind: "email_verify",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  try {
    await sendEmail({
      to: user.email,
      subject: "Ton code FripCash",
      html: verificationEmailHtml(user.name || "", code),
      text: `Ton code FripCash : ${code}`,
    });
  } catch (err) {
    logger.error({ err, email: user.email }, "Envoi du code email impossible");
    if (!isDev) throw err;
  }
  logger.info({ email: user.email, echoed: env.otpDevEcho }, "Code email émis");
  return code;
}

authRouter.post(
  "/phone-number/send-otp",
  validate(z.object({ phoneNumber: z.string().min(6) })),
  ah(async (req, res) => {
    const phone = String(req.body.phoneNumber).replace(/\s/g, "");
    const code = isDev && env.otpDevEcho ? "000000" : randomDigits(6);
    await OtpCode.deleteMany({ phone });
    await OtpCode.create({
      phone,
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    res.json({
      message: "OTP envoyé",
      ...(env.otpDevEcho ? { code } : {}),
    });
  })
);

authRouter.post(
  "/phone-number/verify",
  validate(
    z.object({
      phoneNumber: z.string().min(6),
      code: z.string().min(4),
      signupRole: z.enum(SIGNUP_ROLES).optional(),
      name: z.string().min(1).optional(),
      displayName: z.string().min(1).optional(),
    })
  ),
  ah(async (req, res) => {
    const phone = String(req.body.phoneNumber).replace(/\s/g, "");
    const otp = await OtpCode.findOne({ phone, code: req.body.code });
    if (!otp || otp.expiresAt < new Date()) {
      throw badRequest("INVALID_OTP", "Code OTP invalide");
    }
    await OtpCode.deleteMany({ phone });
    let user = await User.findOne({ phone });
    if (!user) {
      user = await User.create({
        phone,
        name: req.body.name || req.body.displayName || phone,
        phoneNumberVerified: true,
        authAudience: "CONSUMER",
        canBuy: true,
      });
      applySignupRole(user, req.body.signupRole);
      await user.save();
    } else {
      if (user.banned) throw forbidden("BANNED", "Compte suspendu");
      user.phoneNumberVerified = true;
      if (!user.seller && req.body.signupRole) {
        applySignupRole(user, req.body.signupRole);
      }
      await user.save();
    }
    const aud = audienceForUser(user);
    const token = await issue(req, user, aud);
    res.json({ status: true, token, user: toAuthUser(user) });
  })
);

authRouter.post(
  "/sign-up/email",
  validate(
    z.object({
      email: z.string().email(),
      password: passwordSchema,
      name: z.string().min(1),
      signupRole: z.enum(SIGNUP_ROLES).optional(),
    })
  ),
  ah(async (req, res) => {
    const email = String(req.body.email).toLowerCase();
    const exists = await User.findOne({ email });
    if (exists) throw badRequest("EMAIL_TAKEN", "Cet email est déjà utilisé");
    const user = await User.create({
      email,
      name: req.body.name,
      passwordHash: await bcrypt.hash(req.body.password, 10),
      authAudience: "CONSUMER",
      canBuy: true,
      emailVerified: false,
    });
    applySignupRole(user, req.body.signupRole);
    await user.save();
    const token = await issue(req, user, "CONSUMER");
    const code = await issueEmailVerificationCode(user);
    res.json({
      token,
      user: toAuthUser(user),
      ...(env.otpDevEcho && code ? { verificationCode: code } : {}),
    });
  })
);

authRouter.post(
  "/sign-in/email",
  validate(z.object({ email: z.string().email(), password: z.string().min(1) })),
  ah(async (req, res) => {
    const email = String(req.body.email).toLowerCase();
    const user = await User.findOne({ email });
    if (!user?.passwordHash) {
      throw unauthorized("Identifiants invalides");
    }
    if (user.banned) throw forbidden("BANNED", "Compte suspendu");
    const ok = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!ok) throw unauthorized("Identifiants invalides");
    const aud = audienceForUser(user);
    const token = await issue(req, user, aud);
    let verificationCode: string | null = null;
    if (user.email && !user.emailVerified) {
      verificationCode = await issueEmailVerificationCode(user);
    }
    res.json({
      token,
      user: toAuthUser(user),
      session: { token },
      ...(env.otpDevEcho && verificationCode
        ? { verificationCode }
        : {}),
    });
  })
);

export async function handleAdminLogin(req: AuthedRequest, res: any) {
  const email = String(req.body.email).toLowerCase();
  const user = await User.findOne({ email });
  if (!user?.passwordHash || !user.isAdmin) {
    throw unauthorized("Identifiants admin invalides");
  }
  const ok = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!ok) throw unauthorized("Identifiants admin invalides");
  user.authAudience = "ADMIN";
  await user.save();
  const token = await issue(req, user, "ADMIN");
  res.json({ token, user: toAuthUser(user), redirect: true });
}

authRouter.post(
  "/courier/login",
  validate(
    z.object({
      email: z.string().email().optional(),
      phone: z.string().optional(),
      password: z.string().min(1),
    })
  ),
  ah(async (req, res) => {
    const user = req.body.email
      ? await User.findOne({ email: String(req.body.email).toLowerCase() })
      : await User.findOne({ phone: req.body.phone });
    if (!user?.passwordHash || user.authAudience !== "COURIER") {
      throw unauthorized("Identifiants livreur invalides");
    }
    const ok = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!ok) throw unauthorized("Identifiants livreur invalides");
    const token = await issue(req, user, "COURIER");
    res.json({ token, user: toAuthUser(user) });
  })
);

authRouter.post(
  "/send-verification-email",
  validate(z.object({ email: z.string().email(), callbackURL: z.string().optional() })),
  ah(async (req, res) => {
    const user = await User.findOne({
      email: String(req.body.email).toLowerCase(),
    });
    if (!user) {
      return res.json({ message: "Si le compte existe, un email a été envoyé" });
    }
    if (user.emailVerified) {
      return res.json({ message: "Email déjà confirmé" });
    }
    const code = await issueEmailVerificationCode(user);
    res.json({
      message: "Code de vérification envoyé",
      ...(env.otpDevEcho && code ? { code } : {}),
    });
  })
);

authRouter.post(
  "/verify-email-code",
  validate(
    z.object({
      email: z.string().email().optional(),
      code: z.string().min(4).max(8),
    })
  ),
  ah(async (req, res) => {
    const code = String(req.body.code).replace(/\D/g, "");
    let user = req.body.email
      ? await User.findOne({ email: String(req.body.email).toLowerCase() })
      : null;
    if (!user) {
      const header = req.header("authorization");
      const raw = header?.startsWith("Bearer ") ? header.slice(7) : "";
      if (raw) {
        try {
          const payload = verifyToken(raw);
          user = await User.findById(payload.sub);
        } catch {
          /* ignore */
        }
      }
    }
    if (!user?.email) throw badRequest("INVALID_OTP", "Code invalide");
    const rec = await AuthToken.findOne({
      userId: user._id,
      token: code,
      kind: "email_verify",
    });
    if (!rec || rec.expiresAt < new Date()) {
      throw badRequest("INVALID_OTP", "Code invalide ou expiré");
    }
    user.emailVerified = true;
    await user.save();
    await AuthToken.deleteMany({ userId: user._id, kind: "email_verify" });
    res.json({ status: true, message: "Email confirmé", user: toAuthUser(user) });
  })
);

authRouter.post(
  "/request-password-reset",
  validate(z.object({ email: z.string().email(), redirectTo: z.string().optional() })),
  ah(async (req, res) => {
    const user = await User.findOne({ email: String(req.body.email).toLowerCase() });
    if (!user) return res.json({ message: "Si le compte existe, un email a été envoyé" });
    const token = randomBytes(24).toString("hex");
    await AuthToken.deleteMany({ userId: user._id, kind: "password_reset" });
    await AuthToken.create({
      userId: user._id,
      token,
      kind: "password_reset",
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    const origin =
      req.body.redirectTo ||
      env.corsOrigin.split(",")[0]?.trim() ||
      "http://localhost:3000";
    const link = `${String(origin).replace(/\/$/, "")}/mot-de-passe-oublie?token=${token}`;
    try {
      await sendEmail({
        to: user.email!,
        subject: "Réinitialise ton mot de passe FripCash",
        html: resetEmailHtml(user.name || "", link),
        text: `Réinitialise ton mot de passe : ${link}`,
      });
    } catch (err) {
      logger.error({ err, email: user.email }, "Envoi reset password impossible");
      if (!isDev) throw err;
    }
    res.json({
      message: "Lien de réinitialisation envoyé",
      ...(env.otpDevEcho ? { token } : {}),
    });
  })
);

authRouter.post(
  "/reset-password",
  validate(z.object({ token: z.string().min(8), newPassword: passwordSchema })),
  ah(async (req, res) => {
    const rec = await AuthToken.findOne({ token: req.body.token, kind: "password_reset" });
    if (!rec || rec.expiresAt < new Date()) throw badRequest("INVALID_TOKEN", "Lien invalide");
    const user = await User.findById(rec.userId);
    if (!user) throw unauthorized();
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
    await user.save();
    await AuthToken.deleteMany({ userId: user._id, kind: "password_reset" });
    await revokeAllSessions(String(user._id));
    res.json({ status: true });
  })
);

authRouter.post(
  "/sign-out",
  ah(async (req, res) => {
    const token = bearer(req);
    if (token) await revokeSession(token);
    res.json({ status: true });
  })
);

authRouter.get(
  "/get-session",
  requireAuth,
  ah(async (req, res) => {
    const user = (req as AuthedRequest).userDoc!;
    res.json({
      session: { token: bearer(req as AuthedRequest) },
      user: toAuthUser(user),
    });
  })
);

authRouter.get(
  "/me-alias",
  requireAuth,
  ah(async (req, res) => {
    res.json(toMe((req as AuthedRequest).userDoc!));
  })
);
