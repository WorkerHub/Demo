/**
 * 个人设置接口（规格 §6.1「设置」页的后端）：资料与偏好、改密、通行密钥列表/删除。
 *
 * 会话由 `index.ts` 的全局中间件统一校验（`/api/*` 里除公开表之外都要会话），
 * 所以这里不重复挂 `authMiddleware`。凭据类绑定动作不放这里：
 * - TOTP 绑定/关闭、通行密钥注册 → `routes/twofa-manage.ts`（`/api/auth/2fa/*`）；
 * - 删除通行密钥属「我的东西」，留在本文件，但仍要求重新输入密码。
 *
 * 与前端（C 单）对齐的契约：
 * - `GET/PUT /api/me`，`PUT` 为正式契约，`PATCH` 保留同义别名；
 * - `PUT /api/me` 接受 `username`（可自定义、全局唯一，规则见 `lib/username.ts`；
 *   `''` = 未设置）；冲突回 409 `USERNAME_TAKEN`，形状不合法回 400 `INVALID_USERNAME`；
 * - `PUT /api/me/password {currentPassword,newPassword}`（`POST` 同义别名）；
 * - `GET /api/me/passkeys → {items:[{id,createdAt,lastUsedAt,transports}]}`；
 * - `DELETE /api/me/passkeys/:id {password}`。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { hashPassword } from "../core/auth"
import { revokeAllSessions } from "../core/session"
import { deletePasskey, listPasskeyViews } from "../db/queries/passkeys"
import {
  findUserById,
  isUsernameTaken,
  updateUserFields
} from "../db/queries/users"
import { currentUserId, requirePassword } from "../lib/account"
import { apiError, readJsonBody } from "../lib/http"
import { readProfileLockSettings } from "../lib/settings"
import { getTablePrefix } from "../lib/table-prefix"
import { isValidTimezone } from "../lib/timezone"
import { buildUserView } from "../lib/user-view"
import { normalizeUsername } from "../lib/username"
import { normalizeLanguage } from "../locales/email"
import type { HonoEnv } from "../types"

export const meRoutes = new Hono<HonoEnv>()

const THEMES = ["light", "dark", "system"]

type Ctx = Context<HonoEnv>

meRoutes.get("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  const user = await findUserById(c.env.DB, prefix, currentUserId(c))
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
  return c.json(await buildUserView(c.env, user))
})

/** 资料与偏好：只更新请求体里出现的字段；非法值整单拒绝。 */
async function updateProfile(c: Ctx): Promise<Response> {
  const body = await readJsonBody<{
    displayName?: unknown
    username?: unknown
    language?: unknown
    theme?: unknown
    timezone?: unknown
  }>(c)
  if (!body) return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")

  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  const locks = await readProfileLockSettings(c.env)
  const patch: Parameters<typeof updateUserFields>[3] = {}

  if (body.displayName !== undefined && locks.displayNameLocked) {
    return apiError(c, 403, "DISPLAY_NAME_LOCKED", "Display name is locked")
  }
  if (body.username !== undefined && locks.usernameLocked) {
    return apiError(c, 403, "USERNAME_LOCKED", "Username is locked")
  }

  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") {
      return apiError(c, 400, "INVALID_DISPLAY_NAME", "Invalid display name")
    }
    patch.display_name = body.displayName.trim().slice(0, 80)
  }

  // 用户名：形状由 lib/username.ts 定，唯一性先预检、最终由库层的部分唯一索引裁决。
  if (body.username !== undefined) {
    const username = normalizeUsername(body.username)
    if (!username) {
      return apiError(c, 400, "INVALID_USERNAME", "Invalid username")
    }
    if (await isUsernameTaken(c.env.DB, prefix, username, userId)) {
      return apiError(c, 409, "USERNAME_TAKEN", "Username is already taken")
    }
    patch.username = username
  }

  if (body.language !== undefined) {
    const language = normalizeLanguage(body.language)
    if (!language) {
      return apiError(c, 400, "INVALID_LANGUAGE", "Unsupported language")
    }
    patch.language = language
  }

  if (body.theme !== undefined) {
    if (typeof body.theme !== "string" || !THEMES.includes(body.theme)) {
      return apiError(c, 400, "INVALID_THEME", "Unsupported theme")
    }
    patch.theme = body.theme
  }

  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) {
      return apiError(c, 400, "INVALID_TIMEZONE", "Invalid timezone")
    }
    patch.timezone = body.timezone
  }

  try {
    await updateUserFields(c.env.DB, prefix, userId, patch)
  } catch (err) {
    // 预检与写入之间有人抢先注册同名：唯一索引是最终裁决（与注册处的 EMAIL_TAKEN 同写法）。
    if (
      patch.username !== undefined &&
      err instanceof Error &&
      /UNIQUE/i.test(err.message)
    ) {
      return apiError(c, 409, "USERNAME_TAKEN", "Username is already taken")
    }
    throw err
  }
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return apiError(c, 404, "USER_NOT_FOUND", "User not found")
  return c.json(await buildUserView(c.env, user))
}

meRoutes.put("/", updateProfile)
meRoutes.patch("/", updateProfile)

// ─── 改密 ────────────────────────────────────────────────────────────────────

async function changePassword(c: Ctx): Promise<Response> {
  const body = await readJsonBody<{
    currentPassword?: unknown
    newPassword?: unknown
  }>(c)
  const denied = await requirePassword(c, body?.currentPassword)
  if (denied) return denied

  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : ""
  if (newPassword.length < 8) {
    return apiError(
      c,
      400,
      "WEAK_PASSWORD",
      "Password must be at least 8 characters"
    )
  }

  const prefix = getTablePrefix(c.env)
  const userId = currentUserId(c)
  await updateUserFields(c.env.DB, prefix, userId, {
    password_hash: await hashPassword(newPassword),
    must_change_password: 0
  })
  // 改密后其它会话立即失效，当前会话保留（规格 §5.6.2）。
  await revokeAllSessions(c.env.DB, prefix, userId, c.get("sessionId"))
  return c.json({ success: true })
}

meRoutes.put("/password", changePassword)
meRoutes.post("/password", changePassword)

// ─── 通行密钥（列表 / 删除） ─────────────────────────────────────────────────

meRoutes.get("/passkeys", async (c) => {
  const prefix = getTablePrefix(c.env)
  return c.json({
    items: await listPasskeyViews(c.env.DB, prefix, currentUserId(c))
  })
})

meRoutes.delete("/passkeys/:id", async (c) => {
  const body = await readJsonBody<{ password?: unknown }>(c)
  const denied = await requirePassword(c, body?.password)
  if (denied) return denied

  const id = Number(c.req.param("id"))
  if (!Number.isInteger(id)) {
    return apiError(c, 404, "PASSKEY_NOT_FOUND", "Passkey not found")
  }
  const prefix = getTablePrefix(c.env)
  const removed = await deletePasskey(c.env.DB, prefix, currentUserId(c), id)
  if (!removed) {
    return apiError(c, 404, "PASSKEY_NOT_FOUND", "Passkey not found")
  }
  return c.json({ success: true })
})
