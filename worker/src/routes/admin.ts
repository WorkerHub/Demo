/**
 * 系统管理接口（规格 §5.3、§5.5A、§5.6、§6.1）。
 *
 * 全部经 `adminMiddleware`：未登录 401、非管理员 403（前端隐藏菜单只是体验，
 * 服务端这一层才是边界）。凭据字段只写不读——`GET /settings` 只给
 * `passwordSet` / `apiKeySet`。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { APP_MODE } from "../config/project"
import { generateTemporaryPassword, hashPassword } from "../core/auth"
import { clearCounter } from "../core/counters"
import { revokeAllSessions } from "../core/session"
import {
  approveUser,
  deletePendingUser,
  disableUser,
  findUserByEmail,
  findUserById,
  hardDeleteUser,
  insertAdminCreatedUser,
  isUserStatus,
  listUsers,
  setUserRole,
  updateUserFields,
  type UserRow,
  type UserStatus
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
  // 全量用户（管理员用户列表）；`?status=` 可选，缺省返回全部。
  // 列表包裹字段与 /api/me/passkeys 一致：冻结契约为 { items }。
  let status: UserStatus | undefined
  const rawStatus = c.req.query("status")
  if (rawStatus !== undefined) {
    if (!isUserStatus(rawStatus)) {
      return apiError(c, 400, "INVALID_STATUS", "Invalid status filter")
    }
    status = rawStatus
  }
  const prefix = getTablePrefix(c.env)
  return c.json({ items: await listUsers(c.env.DB, prefix, status) })
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

  let user: UserRow
  try {
    user = await insertAdminCreatedUser(c.env.DB, prefix, {
      email,
      passwordHash,
      role,
      displayName,
      language,
      timezone
    })
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      // 预检与写入之间被并发抢先：users 上只剩 email 一个唯一约束。
      return apiError(c, 409, "EMAIL_TAKEN", "Email is already registered")
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

// ─── 用户管理操作（规格第2项）：重置密码 / 停用启用 / 改角色 / 删除 ───────────

type AdminCtx = Context<HonoEnv>

/** 解析 `:id` 并取目标用户：非法或不存在一律 404 USER_NOT_FOUND。 */
async function loadUserTarget(c: AdminCtx): Promise<UserRow | Response> {
  const id = Number(c.req.param("id"))
  if (!Number.isInteger(id)) {
    return apiError(c, 404, "USER_NOT_FOUND", "User not found")
  }
  const user = await findUserById(c.env.DB, getTablePrefix(c.env), id)
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
  return user
}

adminRoutes.post("/users/:id/reset-password", async (c) => {
  const target = await loadUserTarget(c)
  if (target instanceof Response) return target

  const prefix = getTablePrefix(c.env)
  const temporaryPassword = generateTemporaryPassword()
  await updateUserFields(c.env.DB, prefix, target.id, {
    password_hash: await hashPassword(temporaryPassword),
    must_change_password: 1
  })
  // 一次性密码换掉后，该用户现有会话全部失效（规格第2项）。
  await revokeAllSessions(c.env.DB, prefix, target.id)
  // 登录失败锁最长 15 分钟：不就地解开，新密码也会被旧锁挡住。动作名与
  // routes/auth.ts 的 LOGIN_FAIL / LOGIN_LOCK 保持一致。
  await clearCounter(c.env.DB, prefix, {
    action: "login_fail",
    account: target.email
  })
  await clearCounter(c.env.DB, prefix, {
    action: "login_lock",
    account: target.email
  })

  return c.json({ success: true, email: target.email, temporaryPassword })
})

adminRoutes.post("/users/:id/disable", async (c) => {
  const target = await loadUserTarget(c)
  if (target instanceof Response) return target
  if (target.id === c.get("userId")) {
    return apiError(
      c,
      403,
      "SELF_ACTION_FORBIDDEN",
      "You cannot disable your own account"
    )
  }

  const prefix = getTablePrefix(c.env)
  const disabled = await disableUser(c.env.DB, prefix, target.id)
  if (!disabled) {
    // 条件写没生效：要么被并发删掉，要么撞上「最后一名可用管理员」。
    const latest = await findUserById(c.env.DB, prefix, target.id)
    if (!latest) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
    if (latest.status !== "disabled") {
      return apiError(
        c,
        409,
        "LAST_ADMIN",
        "The last active administrator cannot be disabled"
      )
    }
  }
  // 已停用的历史行也一并吊销，不依赖读侧的状态判断。
  await revokeAllSessions(c.env.DB, prefix, target.id)
  return c.json({ success: true })
})

adminRoutes.post("/users/:id/enable", async (c) => {
  const target = await loadUserTarget(c)
  if (target instanceof Response) return target

  await updateUserFields(c.env.DB, getTablePrefix(c.env), target.id, {
    status: "active"
  })
  return c.json({ success: true })
})

adminRoutes.post("/users/:id/role", async (c) => {
  const body = await readJsonBody<{ role?: unknown }>(c)
  if (!body) return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")
  const role = body.role
  if (role !== "admin" && role !== "user") {
    return apiError(c, 400, "INVALID_ROLE", "Role must be admin or user")
  }

  const target = await loadUserTarget(c)
  if (target instanceof Response) return target

  const prefix = getTablePrefix(c.env)
  const changed = await setUserRole(c.env.DB, prefix, target.id, role)
  if (!changed) {
    const latest = await findUserById(c.env.DB, prefix, target.id)
    if (!latest) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
    if (latest.role !== role) {
      return apiError(
        c,
        409,
        "LAST_ADMIN",
        "The last active administrator cannot be demoted"
      )
    }
  }
  return c.json({ success: true })
})

adminRoutes.delete("/users/:id", async (c) => {
  const target = await loadUserTarget(c)
  if (target instanceof Response) return target
  if (target.id === c.get("userId")) {
    return apiError(
      c,
      403,
      "SELF_ACTION_FORBIDDEN",
      "You cannot delete your own account"
    )
  }

  const prefix = getTablePrefix(c.env)
  const deleted = await hardDeleteUser(
    c.env.DB,
    prefix,
    target.id,
    target.email
  )
  if (!deleted) {
    const latest = await findUserById(c.env.DB, prefix, target.id)
    if (!latest) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
    return apiError(
      c,
      409,
      "LAST_ADMIN",
      "The last active administrator cannot be deleted"
    )
  }
  return c.json({ success: true })
})
