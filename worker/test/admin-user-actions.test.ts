/**
 * 用户管理四项操作（第2项后端）：重置密码 / 停用启用 / 改角色 / 硬删，
 * 及其服务端护栏（对自己禁用、最后一名可用管理员）与会话失效。
 *
 * 契约见 web/src/lib/api-types.ts 的 AdminUserActionResult /
 * AdminResetPasswordResult；错误码见各路由。
 */
import { describe, expect, it } from "vitest"
import {
  emailCodesTable,
  passkeysTable,
  sessionsTable,
  user2faTable,
  usersTable
} from "../src/lib/tables"
import type { Env } from "../src/types"
import {
  activePrefix,
  cookieFrom,
  initializedContext,
  loginUser,
  postJson,
  putJson,
  registerUser,
  request,
  type TestContext
} from "./support/app"

type Db = TestContext["db"]

async function adminCookie(env: Env): Promise<string> {
  return cookieFrom(await loginUser(env, { email: "owner@example.test" }))
}

interface AdminCreated {
  id: number
  temporaryPassword: string
}

/** 管理员建号：直接激活、已知一次性初始密码，便于后续登录。 */
async function createUser(
  env: Env,
  admin: string,
  email: string,
  role: "admin" | "user" = "user"
): Promise<AdminCreated> {
  const res = await postJson(
    env,
    "/api/admin/users",
    { email, role },
    { cookie: admin }
  )
  expect(res.status).toBe(200)
  return (await res.json()) as AdminCreated
}

async function currentUserId(env: Env, cookie: string): Promise<number> {
  const res = await request(env, "/api/me", { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: number }
  return body.id
}

function countRows(
  db: Db,
  table: string,
  column: string,
  value: number | string
): number {
  const row = db.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .get(value) as { n: number }
  return row.n
}

async function bodyCode(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

describe("用户管理操作：访问控制", () => {
  it("未登录 401、非管理员 403", async () => {
    const { env } = await initializedContext()
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)
    const target = await createUser(env, admin, "target@example.test")
    const userCookie = cookieFrom(
      await loginUser(env, {
        email: "target@example.test",
        password: target.temporaryPassword
      })
    )

    const calls: Array<{
      method: string
      path: string
      body?: unknown
    }> = [
      {
        method: "POST",
        path: `/api/admin/users/${target.id}/reset-password`
      },
      { method: "POST", path: `/api/admin/users/${target.id}/disable` },
      { method: "POST", path: `/api/admin/users/${target.id}/enable` },
      {
        method: "POST",
        path: `/api/admin/users/${target.id}/role`,
        body: { role: "user" }
      },
      { method: "DELETE", path: `/api/admin/users/${target.id}` }
    ]

    for (const call of calls) {
      const anonymous =
        call.body === undefined
          ? await request(env, call.path, { method: call.method })
          : await postJson(env, call.path, call.body)
      expect(anonymous.status, `未登录 ${call.method} ${call.path}`).toBe(401)

      const forbidden =
        call.body === undefined
          ? await request(env, call.path, {
              method: call.method,
              headers: { cookie: userCookie }
            })
          : await postJson(env, call.path, call.body, { cookie: userCookie })
      expect(forbidden.status, `非管理员 ${call.method} ${call.path}`).toBe(403)
    }
  })

  it("不存在的用户 404 USER_NOT_FOUND，非法 role 400 INVALID_ROLE", async () => {
    const { env } = await initializedContext()
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)

    const missing = await postJson(
      env,
      "/api/admin/users/99999/reset-password",
      {},
      { cookie: admin }
    )
    expect(missing.status).toBe(404)
    expect(await bodyCode(missing)).toBe("USER_NOT_FOUND")

    const notNumeric = await request(env, "/api/admin/users/abc", {
      method: "DELETE",
      headers: { cookie: admin }
    })
    expect(notNumeric.status).toBe(404)

    const target = await createUser(env, admin, "target@example.test")
    const invalid = await postJson(
      env,
      `/api/admin/users/${target.id}/role`,
      { role: "boss" },
      { cookie: admin }
    )
    expect(invalid.status).toBe(400)
    expect(await bodyCode(invalid)).toBe("INVALID_ROLE")
  })
})

describe("重置密码", () => {
  it("一次性密码只此返回、旧密码与旧会话失效、强制改密标记置位", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)
    const target = await createUser(env, admin, "target@example.test")

    const initial = await loginUser(env, {
      email: "target@example.test",
      password: target.temporaryPassword
    })
    expect(initial.status).toBe(200)
    const cookie = cookieFrom(initial)

    // 先把强制改密标记清掉，才能证明重置会重新置位。
    const changed = await putJson(
      env,
      "/api/me/password",
      {
        currentPassword: target.temporaryPassword,
        newPassword: "user-chosen-password"
      },
      { cookie }
    )
    expect(changed.status).toBe(200)

    const res = await postJson(
      env,
      `/api/admin/users/${target.id}/reset-password`,
      {},
      { cookie: admin }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      email: string
      temporaryPassword: string
    }
    expect(body.success).toBe(true)
    expect(body.email).toBe("target@example.test")
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(8)
    expect(body.temporaryPassword).not.toBe(target.temporaryPassword)

    // 现有会话立即失效。
    const me = await request(env, "/api/me", { headers: { cookie } })
    expect(me.status).toBe(401)

    // 库里只有哈希，且强制改密标记回到 1。
    const row = db.db
      .prepare(
        `SELECT password_hash, must_change_password FROM ${usersTable(prefix)}
          WHERE id = ?`
      )
      .get(target.id) as { password_hash: string; must_change_password: number }
    expect(row.password_hash).not.toContain(body.temporaryPassword)
    expect(row.must_change_password).toBe(1)

    // 旧密码作废，新一次性密码可登录并带着强制改密标记。
    const stale = await loginUser(env, {
      email: "target@example.test",
      password: "user-chosen-password"
    })
    expect(stale.status).toBe(401)
    const fresh = await loginUser(env, {
      email: "target@example.test",
      password: body.temporaryPassword
    })
    expect(fresh.status).toBe(200)
    const freshBody = (await fresh.json()) as {
      user: { mustChangePassword: boolean }
    }
    expect(freshBody.user.mustChangePassword).toBe(true)

    // 列表不回显一次性密码。
    const list = await request(env, "/api/admin/users", {
      headers: { cookie: admin }
    })
    const listBody = (await list.json()) as {
      items: Array<Record<string, unknown>>
    }
    const items = listBody.items
    for (const item of items) {
      expect(item).not.toHaveProperty("temporaryPassword")
    }
  })
})

describe("停用与启用", () => {
  it("停用：会话清空、禁止登录、幂等；启用后恢复", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)
    const target = await createUser(env, admin, "target@example.test")
    const cookie = cookieFrom(
      await loginUser(env, {
        email: "target@example.test",
        password: target.temporaryPassword
      })
    )

    const disabled = await postJson(
      env,
      `/api/admin/users/${target.id}/disable`,
      {},
      { cookie: admin }
    )
    expect(disabled.status).toBe(200)

    expect(
      (await request(env, "/api/me", { headers: { cookie } })).status
    ).toBe(401)
    expect(countRows(db, sessionsTable(prefix), "user_id", target.id)).toBe(0)

    const blocked = await loginUser(env, {
      email: "target@example.test",
      password: target.temporaryPassword
    })
    expect(blocked.status).toBe(403)
    expect(await bodyCode(blocked)).toBe("ACCOUNT_DISABLED")

    const row = db.db
      .prepare(`SELECT status FROM ${usersTable(prefix)} WHERE id = ?`)
      .get(target.id) as { status: string }
    expect(row.status).toBe("disabled")

    // 幂等：重复停用仍是成功。
    const again = await postJson(
      env,
      `/api/admin/users/${target.id}/disable`,
      {},
      { cookie: admin }
    )
    expect(again.status).toBe(200)

    const enabled = await postJson(
      env,
      `/api/admin/users/${target.id}/enable`,
      {},
      { cookie: admin }
    )
    expect(enabled.status).toBe(200)
    expect(
      (
        await loginUser(env, {
          email: "target@example.test",
          password: target.temporaryPassword
        })
      ).status
    ).toBe(200)
    // 幂等：对已启用者再启用仍是成功。
    const enabledAgain = await postJson(
      env,
      `/api/admin/users/${target.id}/enable`,
      {},
      { cookie: admin }
    )
    expect(enabledAgain.status).toBe(200)
  })
})

describe("变更角色", () => {
  it("提升/降级即时生效、幂等；唯一管理员不可降级自己", async () => {
    const { env } = await initializedContext()
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)
    const ownerId = await currentUserId(env, admin)
    const target = await createUser(env, admin, "target@example.test")
    const cookie = cookieFrom(
      await loginUser(env, {
        email: "target@example.test",
        password: target.temporaryPassword
      })
    )

    // 普通用户先被管理面拒绝。
    expect(
      (await request(env, "/api/admin/users", { headers: { cookie } })).status
    ).toBe(403)

    const promote = await postJson(
      env,
      `/api/admin/users/${target.id}/role`,
      { role: "admin" },
      { cookie: admin }
    )
    expect(promote.status).toBe(200)
    // 同一 Cookie 立即拿到管理员权限（角色每次请求都从库里读）。
    expect(
      (await request(env, "/api/admin/users", { headers: { cookie } })).status
    ).toBe(200)

    // 幂等：设成当前角色仍是成功。
    const same = await postJson(
      env,
      `/api/admin/users/${target.id}/role`,
      { role: "admin" },
      { cookie: admin }
    )
    expect(same.status).toBe(200)

    const demote = await postJson(
      env,
      `/api/admin/users/${target.id}/role`,
      { role: "user" },
      { cookie: admin }
    )
    expect(demote.status).toBe(200)
    expect(
      (await request(env, "/api/admin/users", { headers: { cookie } })).status
    ).toBe(403)

    // 此时只剩 owner 一名可用管理员：降级自己 → 409。
    const selfDemote = await postJson(
      env,
      `/api/admin/users/${ownerId}/role`,
      { role: "user" },
      { cookie: admin }
    )
    expect(selfDemote.status).toBe(409)
    expect(await bodyCode(selfDemote)).toBe("LAST_ADMIN")
  })
})

describe("删除用户", () => {
  it("硬删并清空会话/两步登录/通行密钥/验证码；不可删或停用自己", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)
    const ownerId = await currentUserId(env, admin)
    const target = await createUser(env, admin, "target@example.test")

    // 造出该用户的会话与关联行。
    await loginUser(env, {
      email: "target@example.test",
      password: target.temporaryPassword
    })
    const now = new Date().toISOString()
    db.db
      .prepare(
        `INSERT INTO ${user2faTable(prefix)} (user_id, totp_secret, totp_enabled, updated_at)
         VALUES (?, 'SECRET', 1, ?)`
      )
      .run(target.id, now)
    db.db
      .prepare(
        `INSERT INTO ${passkeysTable(prefix)}
          (user_id, credential_id, public_key, counter, transports, created_at)
         VALUES (?, 'credential-1', 'public-key', 0, '', ?)`
      )
      .run(target.id, now)
    db.db
      .prepare(
        `INSERT INTO ${emailCodesTable(prefix)}
          (email, purpose, code_hash, expires_at, created_at)
         VALUES (?, 'password_reset', 'hash', ?, ?)`
      )
      .run(
        "target@example.test",
        Math.floor(Date.now() / 1000) + 600,
        Math.floor(Date.now() / 1000)
      )

    expect(countRows(db, sessionsTable(prefix), "user_id", target.id)).toBe(1)

    const res = await request(env, `/api/admin/users/${target.id}`, {
      method: "DELETE",
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    expect(countRows(db, usersTable(prefix), "id", target.id)).toBe(0)
    expect(countRows(db, sessionsTable(prefix), "user_id", target.id)).toBe(0)
    expect(countRows(db, user2faTable(prefix), "user_id", target.id)).toBe(0)
    expect(countRows(db, passkeysTable(prefix), "user_id", target.id)).toBe(0)
    expect(
      countRows(db, emailCodesTable(prefix), "email", "target@example.test")
    ).toBe(0)

    const selfDelete = await request(env, `/api/admin/users/${ownerId}`, {
      method: "DELETE",
      headers: { cookie: admin }
    })
    expect(selfDelete.status).toBe(403)
    expect(await bodyCode(selfDelete)).toBe("SELF_ACTION_FORBIDDEN")

    const selfDisable = await postJson(
      env,
      `/api/admin/users/${ownerId}/disable`,
      {},
      { cookie: admin }
    )
    expect(selfDisable.status).toBe(403)
    expect(await bodyCode(selfDisable)).toBe("SELF_ACTION_FORBIDDEN")
  })
})
