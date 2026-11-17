/**
 * 凭据绑定接口（挂 `/api/auth/2fa`），与登录第二步（`routes/auth.ts` 的
 * `/2fa/verify`、`/2fa/passkey/*`、`/2fa/email/send`）共用同一前缀，便于前端把
 * 「2FA」放一个模块。
 *
 * 与前端（C 单）对齐的契约：
 * - `POST /api/auth/2fa/totp/setup → {secret, otpauthUrl}`
 * - `POST /api/auth/2fa/totp/enable {code}`
 * - `POST /api/auth/2fa/totp/disable {password}`
 * - `POST /api/auth/2fa/email/enable/send`（向本人邮箱发码）
 * - `POST /api/auth/2fa/email/enable {code}`（验码生效）
 * - `POST /api/auth/2fa/email/disable {password}`
 * - `POST /api/auth/2fa/passkey/register/options {password} → options`
 * - `POST /api/auth/2fa/passkey/register/verify {credential}`
 *
 * 这些路径**不在** `index.ts` 的公开白名单里：绑定是登录后的动作，必须带会话。
 */
import { Hono } from "hono"
import { isSigningSecretConfigured } from "../core/auth"
import { enforceRateLimit } from "../core/rate-limit"
import { generateTotpSecret, verifyTotpCode } from "../core/totp"
import {
  checkResendCooldown,
  issueVerificationCode,
  verifyVerificationCode
} from "../core/verification-codes"
import {
  clearChallengeCookie,
  createRegistrationOptions,
  readChallengeCookie,
  relyingParty,
  setChallengeCookie,
  verifyRegistration
} from "../core/webauthn"
import { insertPasskey, listPasskeys } from "../db/queries/passkeys"
import {
  getTwoFactor,
  setEmailTwoFactor,
  upsertTwoFactor
} from "../db/queries/twofa"
import { findUserById } from "../db/queries/users"
import { currentUserId, requirePassword } from "../lib/account"
import { apiError, clientIp, rateLimited, readJsonBody } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import { normalizeLanguage, renderCodeEmail } from "../locales/email"
import { isEmailConfigured, sendEmail } from "../services/email"
import type { HonoEnv } from "../types"

export const twoFactorManageRoutes = new Hono<HonoEnv>()

twoFactorManageRoutes.post("/totp/setup", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")

  const existing = await getTwoFactor(c.env.DB, prefix, userId)
  if (existing?.totp_enabled) {
    return apiError(
      c,
      409,
      "TOTP_ALREADY_ENABLED",
      "TOTP is already enabled; disable it first"
    )
  }

  const { secret, uri } = generateTotpSecret(user.email)
  await upsertTwoFactor(c.env.DB, prefix, userId, {
    totpSecret: secret,
    totpEnabled: 0
  })
  return c.json({ secret, otpauthUrl: uri })
})

twoFactorManageRoutes.post("/totp/enable", async (c) => {
  const body = await readJsonBody<{ code?: unknown }>(c)
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  const twoFactor = await getTwoFactor(c.env.DB, prefix, userId)
  if (!twoFactor?.totp_secret) {
    return apiError(
      c,
      400,
      "TOTP_SETUP_MISSING",
      "Start TOTP setup before enabling it"
    )
  }
  if (twoFactor.totp_enabled) {
    return apiError(c, 409, "TOTP_ALREADY_ENABLED", "TOTP is already enabled")
  }

  if (verifyTotpCode(twoFactor.totp_secret, code) === null) {
    return apiError(c, 400, "INVALID_CODE", "Invalid verification code")
  }

  await upsertTwoFactor(c.env.DB, prefix, userId, {
    totpSecret: twoFactor.totp_secret,
    totpEnabled: 1
  })
  return c.json({ success: true })
})

twoFactorManageRoutes.post("/totp/disable", async (c) => {
  const body = await readJsonBody<{ password?: unknown }>(c)
  const denied = await requirePassword(c, body?.password)
  if (denied) return denied

  const prefix = getTablePrefix(c.env)
  await upsertTwoFactor(c.env.DB, prefix, currentUserId(c), {
    totpSecret: null,
    totpEnabled: 0
  })
  return c.json({ success: true })
})

// ─── 邮箱验证码（第二因子） ─────────────────────────────────────────────────────

/**
 * 邮箱因子：发码 → 验码生效 → 停用复核密码。
 *
 * 码复用 `core/verification-codes.ts`（`purpose = twofa_email`：6 位、哈希存库、
 * 10 分钟、5 次尝试、单次使用、60 秒冷却），不另造一套。启用必须真的把码送到本人
 * 邮箱：邮件未配置就 409 `EMAIL_NOT_CONFIGURED`（口径同既有依赖邮件的流程），发送
 * 失败就 502 `EMAIL_SEND_FAILED`——拿不到码就不许开，绝不假装成功。
 */

/** 启用发码限流：按用户 + IP，5 分钟 5 次（冷却另算，见 CODE_COOLDOWN）。 */
const EMAIL_ENABLE_SEND_LIMIT = {
  action: "2fa_email_enable_send",
  windowSeconds: 300,
  max: 5
}

twoFactorManageRoutes.post("/email/enable/send", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")

  const twoFactor = await getTwoFactor(c.env.DB, prefix, userId)
  if (twoFactor?.email_enabled) {
    return apiError(
      c,
      409,
      "EMAIL_ALREADY_ENABLED",
      "The email second factor is already enabled"
    )
  }
  if (!(await isEmailConfigured(c.env))) {
    return apiError(
      c,
      409,
      "EMAIL_NOT_CONFIGURED",
      "Email delivery is not configured on this site"
    )
  }

  const limit = await enforceRateLimit(c.env.DB, prefix, {
    ...EMAIL_ENABLE_SEND_LIMIT,
    account: String(userId),
    ip: clientIp(c)
  })
  if (!limit.allowed) return rateLimited(c, limit.retryAfter)

  const cooldown = await checkResendCooldown(c.env, {
    email: user.email,
    purpose: "twofa_email"
  })
  if (!cooldown.allowed) {
    return apiError(
      c,
      429,
      "CODE_COOLDOWN",
      "Please wait before requesting another code",
      { retryAfter: cooldown.retryAfter }
    )
  }

  const { code } = await issueVerificationCode(c.env, {
    email: user.email,
    purpose: "twofa_email"
  })
  const content = renderCodeEmail(
    normalizeLanguage(user.language) ?? "zh",
    "twofa_email",
    code
  )
  const result = await sendEmail(c.env, {
    to: user.email,
    subject: content.subject,
    html: content.html,
    text: content.text
  })
  if (!result.success) {
    console.error(
      "2FA email enable code failed:",
      result.error ?? "unknown error"
    )
    return apiError(
      c,
      502,
      "EMAIL_SEND_FAILED",
      "Failed to send the verification email"
    )
  }
  return c.json({ success: true })
})

twoFactorManageRoutes.post("/email/enable", async (c) => {
  const body = await readJsonBody<{ code?: unknown }>(c)
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")

  const twoFactor = await getTwoFactor(c.env.DB, prefix, userId)
  if (twoFactor?.email_enabled) {
    return apiError(
      c,
      409,
      "EMAIL_ALREADY_ENABLED",
      "The email second factor is already enabled"
    )
  }

  const verdict = await verifyVerificationCode(c.env, {
    email: user.email,
    purpose: "twofa_email",
    code
  })
  if (!verdict.ok) {
    return apiError(c, 400, "INVALID_CODE", "Invalid verification code")
  }

  await setEmailTwoFactor(c.env.DB, prefix, userId, true)
  return c.json({ success: true })
})

twoFactorManageRoutes.post("/email/disable", async (c) => {
  const body = await readJsonBody<{ password?: unknown }>(c)
  // 停用敏感因子要复核当前密码（与 TOTP 停用、通行密钥删除同口径）。
  const denied = await requirePassword(c, body?.password)
  if (denied) return denied

  await setEmailTwoFactor(
    c.env.DB,
    getTablePrefix(c.env),
    currentUserId(c),
    false
  )
  return c.json({ success: true })
})

// ─── 通行密钥注册 ────────────────────────────────────────────────────────────

twoFactorManageRoutes.post("/passkey/register/options", async (c) => {
  const body = await readJsonBody<{ password?: unknown }>(c)
  const denied = await requirePassword(c, body?.password)
  if (denied) return denied

  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")

  const options = await createRegistrationOptions({
    rp: relyingParty(c),
    userName: user.email,
    userDisplayName: user.display_name || user.email,
    excludeCredentialIds: (await listPasskeys(c.env.DB, prefix, userId)).map(
      (passkey) => passkey.credential_id
    )
  })
  // 挑战要放进签名 Cookie，需要签名钥；没配就失败关闭。
  if (!isSigningSecretConfigured(c.env.SIGNING_SECRET)) {
    return apiError(
      c,
      500,
      "AUTH_UNAVAILABLE",
      "Signing secret is not configured on this server"
    )
  }
  await setChallengeCookie(
    c,
    c.env.SIGNING_SECRET as string,
    options.challenge,
    "register"
  )
  return c.json(options)
})

twoFactorManageRoutes.post("/passkey/register/verify", async (c) => {
  const body = await readJsonBody<{ credential?: unknown; response?: unknown }>(
    c
  )
  // `credential` 是前端契约字段；`response` 是 @simplewebauthn 的原名，兼容保留。
  const credential = body?.credential ?? body?.response
  if (!credential) {
    return apiError(c, 400, "PASSKEY_FAILED", "Passkey credential is required")
  }
  if (!isSigningSecretConfigured(c.env.SIGNING_SECRET)) {
    return apiError(
      c,
      500,
      "AUTH_UNAVAILABLE",
      "Signing secret is not configured on this server"
    )
  }

  const challenge = await readChallengeCookie(
    c,
    c.env.SIGNING_SECRET as string,
    "register"
  )
  if (!challenge) {
    return apiError(
      c,
      400,
      "PASSKEY_CHALLENGE_MISSING",
      "No pending passkey challenge; request options again"
    )
  }

  const verdict = await verifyRegistration({
    response: credential,
    expectedChallenge: challenge,
    rp: relyingParty(c)
  })
  clearChallengeCookie(c)
  if (!verdict.verified) {
    return apiError(c, 400, "PASSKEY_FAILED", "Passkey registration failed")
  }

  const prefix = getTablePrefix(c.env)
  await insertPasskey(c.env.DB, prefix, {
    userId: currentUserId(c),
    credentialId: verdict.credential.id,
    publicKey: verdict.credential.publicKey,
    counter: verdict.credential.counter,
    transports: verdict.credential.transports
  })
  return c.json({ success: true }, 201)
})
