/**
 * 系统管理接口（规格 §5.3、§5.5A、§5.6、§6.1）。
 *
 * 全部经 `adminMiddleware`：未登录 401、非管理员 403（前端隐藏菜单只是体验，
 * 服务端这一层才是边界）。凭据字段只写不读——`GET /settings` 只给
 * `passwordSet` / `apiKeySet`。
 */
import { Hono } from "hono"
import { APP_MODE } from "../config/project"
import { generateTemporaryPassword, hashPassword } from "../core/auth"
import {
  approveUser,
  deletePendingUser,
  findUserByEmail,
  findUserById,
  insertAdminCreatedUser,
  isUsernameTaken,
  listPendingUsers
} from "../db/queries/users"
import { apiError, readJsonBody } from "../lib/http"
import {
  buildAdminSettings,
  writeProfileLockSettings,
  writeRegistrationSettings,
  writeSetupPageEnabled,
  type ProfileLockSettingsPatch,
  type RegistrationSettingsPatch
} from "../lib/settings"
import { runSetup } from "../lib/setup"
import { getTablePrefix } from "../lib/table-prefix"
import { isValidTimezone } from "../lib/timezone"
import { normalizeUsername } from "../lib/username"
import { adminMiddleware } from "../middleware/admin"
import { normalizeLanguage, renderTestEmail } from "../locales/email"
import {
  isEmailConfigured,
  isValidEmail,
  saveEmailSettings,
  sendEmail,
  type EmailProvider,
  type EmailSettingsPatch
} from "../services/email"
import type { HonoEnv } from "../types"

export const adminRoutes = new Hono<HonoEnv>()

adminRoutes.use("*", adminMiddleware)

adminRoutes.post("/setup", async (c) => {
  try {
    const result = await runSetup(c.env)
    return c.json(result, result.success ? 200 : 409)
  } catch (err) {
    console.error(
      "Admin setup failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Setup failed" }, 500)
  }
})

adminRoutes.get("/settings", async (c) => {
  return c.json(await buildAdminSettings(c.env))
})

adminRoutes.put("/settings", async (c) => {
  const body = await readJsonBody<{
    registration?: RegistrationSettingsPatch | null
    profileLocks?: ProfileLockSettingsPatch
    setup?: { pageEnabled?: boolean }
    email?: EmailSettingsPatch
  }>(c)
  if (!body) {
    return apiError(c, 400, "INVALID_EMAIL", "Invalid request body")
  }

  if (body.profileLocks !== undefined && body.profileLocks !== null) {
    await writeProfileLockSettings(c.env, body.profileLocks)
  }

  if (body.registration !== undefined && body.registration !== null) {
    if (APP_MODE !== "multi") {
      return apiError(
        c,
        400,
        "MODE_CONFLICT",
        "Registration settings are not available in single-user mode"
      )
    }
    const result = await writeRegistrationSettings(c.env, body.registration)
    if (!result.ok) {
      if (result.code === "EMAIL_NOT_CONFIGURED") {
        return apiError(
          c,
          409,
          "EMAIL_NOT_CONFIGURED",
          result.error ?? "Email delivery is not configured"
        )
      }
      return apiError(
        c,
        400,
        result.code ?? "MODE_CONFLICT",
        result.error ?? "Registration settings were rejected"
      )
    }
  }

  if (body.setup?.pageEnabled !== undefined) {
    await writeSetupPageEnabled(c.env, body.setup.pageEnabled)
  }

  if (body.email !== undefined) {
    const provider = body.email.provider
    if (
      provider !== undefined &&
      provider !== "none" &&
      provider !== "smtp" &&
      provider !== "resend"
    ) {
      return apiError(c, 400, "EMAIL_CONFIG_INVALID", "Unknown email provider")
    }
    const result = await saveEmailSettings(c.env, {
      ...body.email,
      provider: provider as EmailProvider | undefined
    })
    if (!result.ok) {
      return apiError(
        c,
        400,
        "EMAIL_CONFIG_INVALID",
        result.error ?? "Invalid email configuration"
      )
    }
  }

  return c.json(await buildAdminSettings(c.env))
})

adminRoutes.post("/settings/test-email", async (c) => {
  const body = await readJsonBody<{ to?: string; language?: string }>(c)
  const to = typeof body?.to === "string" ? body.to.trim() : ""
  if (!to) {
    return apiError(c, 400, "INVALID_EMAIL", "Recipient address is required")
  }
  if (!(await isEmailConfigured(c.env))) {
    return apiError(
      c,
      409,
      "EMAIL_NOT_CONFIGURED",
      "Email delivery is not configured"
    )
  }

  const prefix = getTablePrefix(c.env)
  const admin = await findUserById(c.env.DB, prefix, c.get("userId"))
  const language =
    normalizeLanguage(body?.language) ??
    normalizeLanguage(admin?.language) ??
    "zh"
  const content = renderTestEmail(language)
  const result = await sendEmail(c.env, {
    to,
    subject: content.subject,
    html: content.html,
    text: content.text
  })

  if (!result.success) {
    // 原文回显：管理员要看到 provider 的真实报错才能修配置。
    return apiError(c, 502, "EMAIL_SEND_FAILED", "Test email failed", {
      detail: result.error ?? "unknown error"
    })
  }
  return c.json({ success: true })
})

adminRoutes.get("/users", async (c) => {
  // 目前只有「待批准」这一种筛选需求；参数保留给前端，取值不是 pending 时按 pending 处理。
  // 列表包裹字段与 /api/me/passkeys 一致：冻结契约为 { items }。
  const prefix = getTablePrefix(c.env)
  return c.json({ items: await listPendingUsers(c.env.DB, prefix) })
})

adminRoutes.post("/users/:id/approve", async (c) => {
  const id = Number(c.req.param("id"))
  if (!Number.isInteger(id)) {
    return apiError(c, 404, "USER_NOT_FOUND", "User not found")
  }
  const prefix = getTablePrefix(c.env)
  const approved = await approveUser(c.env.DB, prefix, id)
  if (!approved) {
    const user = await findUserById(c.env.DB, prefix, id)
    if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
    return apiError(c, 409, "USER_NOT_PENDING", "User is not pending approval")
  }
  return c.json({ success: true })
})

adminRoutes.post("/users/:id/reject", async (c) => {
  const id = Number(c.req.param("id"))
  if (!Number.isInteger(id)) {
    return apiError(c, 404, "USER_NOT_FOUND", "User not found")
  }
  const prefix = getTablePrefix(c.env)
  const rejected = await deletePendingUser(c.env.DB, prefix, id)
  if (!rejected) {
    const user = await findUserById(c.env.DB, prefix, id)
    if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
    return apiError(c, 409, "USER_NOT_PENDING", "User is not pending approval")
  }
  return c.json({ success: true })
})

adminRoutes.post("/users", async (c) => {
  const body = await readJsonBody<{
    email?: unknown
    role?: unknown
    displayName?: unknown
    username?: unknown
    language?: unknown
    timezone?: unknown
  }>(c)
  if (!body) return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!isValidEmail(email)) {
    return apiError(c, 400, "INVALID_EMAIL", "Invalid email address")
  }

  const role = body.role
  if (role !== "admin" && role !== "user") {
    return apiError(c, 400, "INVALID_ROLE", "Role must be admin or user")
  }

  const prefix = getTablePrefix(c.env)
  if (await findUserByEmail(c.env.DB, prefix, email)) {
    return apiError(c, 409, "EMAIL_TAKEN", "Email is already registered")
  }

  let displayName = ""
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") {
      return apiError(c, 400, "INVALID_DISPLAY_NAME", "Invalid display name")
    }
    displayName = body.displayName.trim().slice(0, 80)
  }

  let username = ""
  if (body.username !== undefined) {
    const normalized = normalizeUsername(body.username)
    if (!normalized) {
      return apiError(c, 400, "INVALID_USERNAME", "Invalid username")
    }
    if (await isUsernameTaken(c.env.DB, prefix, normalized, 0)) {
      return apiError(c, 409, "USERNAME_TAKEN", "Username is already taken")
    }
    username = normalized
  }

  let language = "zh"
  if (body.language !== undefined) {
    const normalized = normalizeLanguage(body.language)
    if (!normalized) {
      return apiError(c, 400, "INVALID_LANGUAGE", "Unsupported language")
    }
    language = normalized
  }

  let timezone = "Asia/Shanghai"
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) {
      return apiError(c, 400, "INVALID_TIMEZONE", "Invalid timezone")
    }
    timezone = body.timezone
  }

  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)

  let user
  try {
    user = await insertAdminCreatedUser(c.env.DB, prefix, {
      email,
      passwordHash,
      role,
      displayName,
      username,
      language,
      timezone
    })
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      // 预检与写入之间被并发抢先：按约束命中的列归因，email 与 username 各回各的码。
      if (/email/i.test(err.message)) {
        return apiError(c, 409, "EMAIL_TAKEN", "Email is already registered")
      }
      return apiError(c, 409, "USERNAME_TAKEN", "Username is already taken")
    }
    throw err
  }

  return c.json({
    id: user.id,
    email: user.email,
    role: user.role,
    status: "active",
    temporaryPassword
  })
})
