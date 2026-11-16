/**
 * 用户名（冻结契约）：`PUT /api/me` 的校验与唯一性、`GET /api/me` 的回显、
 * 以及库层部分唯一索引的行为（未设置 = ''，多行 '' 可共存，非空重复被拒）。
 */
import { describe, expect, it } from "vitest"
import { usersTable } from "../src/lib/tables"
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  normalizeUsername
} from "../src/lib/username"
import {
  activePrefix,
  cookieFrom,
  initializedContext,
  loginUser,
  putJson,
  registerAndLogin,
  registerUser,
  request
} from "./support/app"

describe("用户名", () => {
  it("PUT 落库并即时回显，未设置时返回空字符串", async () => {
    const { env, db } = await initializedContext()
    const { cookie } = await registerAndLogin(env, {
      email: "owner@example.test"
    })
    const prefix = activePrefix(env)

    const before = await request(env, "/api/me", { headers: { cookie } })
    expect(before.status).toBe(200)
    expect(((await before.json()) as { username: string }).username).toBe("")

    const res = await putJson(
      env,
      "/api/me",
      { username: "  船长_01  " },
      { cookie }
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ username: "船长_01" })

    const me = await request(env, "/api/me", { headers: { cookie } })
    expect(((await me.json()) as { username: string }).username).toBe("船长_01")

    const row = db.db
      .prepare(`SELECT username FROM ${usersTable(prefix)} WHERE email = ?`)
      .get("owner@example.test") as { username: string }
    expect(row.username).toBe("船长_01")
  })

  it("非法形状一律 400 INVALID_USERNAME，整单拒绝", async () => {
    const { env } = await initializedContext()
    const { cookie } = await registerAndLogin(env, {
      email: "owner@example.test"
    })

    const invalid = [
      "",
      "   ",
      "a",
      "x".repeat(USERNAME_MAX_LENGTH + 1),
      "has space",
      "a@b",
      "-lead",
      "_lead",
      "尾部音符😀"
    ]
    for (const username of invalid) {
      const res = await putJson(env, "/api/me", { username }, { cookie })
      expect(res.status, username).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe(
        "INVALID_USERNAME"
      )
    }

    // 同一请求里合法的 displayName 也不该被写进去（整单拒绝）。
    const mixed = await putJson(
      env,
      "/api/me",
      { displayName: "Owner", username: "a@b" },
      { cookie }
    )
    expect(mixed.status).toBe(400)
    const me = await request(env, "/api/me", { headers: { cookie } })
    expect(((await me.json()) as { displayName: string }).displayName).toBe("")
  })

  it("唯一性不分大小写：别人占用回 409，改回自己当前名不算冲突", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const owner = await registerAndLogin(env, {
      email: "owner@example.test"
    })
    const taken = await putJson(
      env,
      "/api/me",
      { username: "Sailor" },
      { cookie: owner.cookie }
    )
    expect(taken.status).toBe(200)

    await registerUser(env, { email: "member@example.test" })
    db.db
      .prepare(
        `UPDATE ${usersTable(prefix)} SET status = 'active' WHERE email = ?`
      )
      .run("member@example.test")
    const member = cookieFrom(
      await loginUser(env, { email: "member@example.test" })
    )

    const conflict = await putJson(
      env,
      "/api/me",
      { username: "sailor" },
      { cookie: member }
    )
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { code: string }).code).toBe(
      "USERNAME_TAKEN"
    )

    const own = await putJson(
      env,
      "/api/me",
      { username: "SAILOR" },
      { cookie: owner.cookie }
    )
    expect(own.status).toBe(200)
    expect(((await own.json()) as { username: string }).username).toBe("SAILOR")

    const free = await putJson(
      env,
      "/api/me",
      { username: "sailor2" },
      { cookie: member }
    )
    expect(free.status).toBe(200)
    expect(((await free.json()) as { username: string }).username).toBe(
      "sailor2"
    )
  })

  it("局部更新：只改 displayName 不动 username；库里多行 '' 可共存", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const owner = await registerAndLogin(env, {
      email: "owner@example.test"
    })
    await registerUser(env, { email: "member@example.test" })

    const unset = db.db
      .prepare(
        `SELECT COUNT(*) AS rows FROM ${usersTable(prefix)} WHERE username = ''`
      )
      .get() as { rows: number }
    expect(unset.rows).toBe(2)

    expect(
      (
        await putJson(
          env,
          "/api/me",
          { username: "Keeper" },
          { cookie: owner.cookie }
        )
      ).status
    ).toBe(200)

    const renamed = await putJson(
      env,
      "/api/me",
      { displayName: "Owner" },
      { cookie: owner.cookie }
    )
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      displayName: "Owner",
      username: "Keeper"
    })
  })

  it("库层部分唯一索引：非空重复被拒，空串不占名", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const table = usersTable(prefix)
    const insert = db.db.prepare(
      `INSERT INTO ${table}
        (email, password_hash, role, status, email_verified, language,
         display_name, username, timezone, created_at, updated_at)
       VALUES (?, 'hash', 'user', 'active', 1, 'zh', '', ?, 'Asia/Shanghai', ?, ?)`
    )
    const now = new Date().toISOString()

    insert.run("a@example.test", "Sailor", now, now)
    expect(() => insert.run("b@example.test", "sailor", now, now)).toThrow(
      /UNIQUE/i
    )
    expect(() => insert.run("c@example.test", "", now, now)).not.toThrow()
    expect(() => insert.run("d@example.test", "", now, now)).not.toThrow()
  })

  it("normalizeUsername 与契约数字一致", () => {
    expect(normalizeUsername("  ab  ")).toBe("ab")
    expect(normalizeUsername("船长")).toBe("船长")
    expect(normalizeUsername("a".repeat(USERNAME_MIN_LENGTH - 1))).toBeNull()
    expect(normalizeUsername("a".repeat(USERNAME_MAX_LENGTH))).toBe(
      "a".repeat(USERNAME_MAX_LENGTH)
    )
    expect(normalizeUsername("a".repeat(USERNAME_MAX_LENGTH + 1))).toBeNull()
    expect(normalizeUsername(42)).toBeNull()
  })
})
