/**
 * 规格 §7-2：迁移账本命名（带前导下划线）与旧账本改名承接。
 * 顺带锁住两条硬约束：基线语句内部不得出现 `;`、表名一律由 tables.ts 拼装。
 */
import { describe, expect, it } from "vitest"
import {
  BASELINE_MIGRATION,
  EMAIL_TWO_FACTOR_MIGRATION,
  MUST_CHANGE_PASSWORD_MIGRATION,
  THEME_REMOVAL_MIGRATION,
  USERNAME_MIGRATION,
  USERNAME_REMOVAL_MIGRATION,
  getMigrations
} from "../src/lib/migrations"
import { splitStatements } from "../src/lib/migrations-runner"
import { ledgerName, runSetup } from "../src/lib/setup"
import {
  indexName,
  legacyMigrationsTable,
  migrationsTable,
  sessionsTable,
  settingsTable,
  usersTable
} from "../src/lib/tables"
import { activePrefix, initializedContext, tableNames } from "./support/app"
import type { SqliteD1 } from "./support/sqlite-d1"

describe("迁移定义", () => {
  it("基线 schema_v1 后按序追加，语句内部不含分号", () => {
    const prefix = "wiki_"
    const migrations = getMigrations(prefix)
    expect(migrations.map((migration) => migration.name)).toEqual([
      BASELINE_MIGRATION,
      USERNAME_MIGRATION,
      MUST_CHANGE_PASSWORD_MIGRATION,
      THEME_REMOVAL_MIGRATION,
      USERNAME_REMOVAL_MIGRATION,
      EMAIL_TWO_FACTOR_MIGRATION
    ])
    for (const migration of migrations) {
      const statements = splitStatements(migration.sql)
      if (!migration.prepare) expect(statements.length).toBeGreaterThan(0)
      for (const statement of statements) {
        expect(statement).not.toContain(";")
      }
    }
    // 基线迁移建表；追加迁移只追加对象（加列在 prepare 里做）。
    for (const statement of splitStatements(migrations[0].sql)) {
      expect(statement.startsWith("CREATE")).toBe(true)
    }
    const usernameSql = migrations[1].sql
    expect(usernameSql).toContain(indexName(prefix, "users_username"))
    expect(usernameSql).toContain(usersTable(prefix))
    expect(usernameSql).toContain("COLLATE NOCASE")
    expect(usernameSql).toContain("WHERE username <> ''")
  })

  it("表名一律带生效前缀（没有任何无前缀表名）", () => {
    const prefix = "wiki_"
    const [migration] = getMigrations(prefix)
    for (const statement of splitStatements(migration.sql)) {
      const tableMatch = statement.match(/CREATE TABLE IF NOT EXISTS (\S+)/)
      if (tableMatch) {
        expect(tableMatch[1].startsWith(prefix)).toBe(true)
      }
    }
  })

  it("无前缀时表名就是逻辑名", () => {
    const sql = getMigrations("")[0].sql
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS users")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS system_settings")
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS _")
  })
})

describe("账本命名", () => {
  it("带前缀：账本带前导下划线，旧版无下划线的名字不会被建出来", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    expect(ledgerName(prefix)).toBe(`_${prefix}schema_migrations`)
    expect(ledgerName(prefix)).toBe(migrationsTable(prefix))

    const tables = tableNames(db)
    expect(tables).toContain(migrationsTable(prefix))
    expect(tables).not.toContain(legacyMigrationsTable(prefix))
  })

  it("无前缀：账本名是 _schema_migrations", async () => {
    const { db } = await initializedContext({ TABLE_PREFIX: "" })
    expect(ledgerName("")).toBe("_schema_migrations")
    expect(tableNames(db)).toContain("_schema_migrations")
  })

  it("重复 setup 只做幂等检查：全部 skipped", async () => {
    const { env } = await initializedContext()
    const again = await runSetup(env)
    expect(again.success).toBe(true)
    if (again.success) {
      expect(again.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }
  })
})

describe("旧账本改名承接", () => {
  it("旧账本在、新账本不在 → 改名承接，已应用记录保留，迁移全部 skipped", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const legacy = legacyMigrationsTable(prefix)

    // 模拟旧版账本形态：把新账本改名回旧名字。
    db.db.exec(`ALTER TABLE ${migrationsTable(prefix)} RENAME TO ${legacy}`)
    expect(tableNames(db)).toContain(legacy)
    expect(tableNames(db)).not.toContain(migrationsTable(prefix))

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }

    const tables = tableNames(db)
    expect(tables).toContain(migrationsTable(prefix))
    expect(tables).not.toContain(legacy)

    const rows = db.db
      .prepare(`SELECT name FROM ${migrationsTable(prefix)}`)
      .all() as Array<{ name: string }>
    expect(rows.map((row) => row.name)).toEqual([
      BASELINE_MIGRATION,
      USERNAME_MIGRATION,
      MUST_CHANGE_PASSWORD_MIGRATION,
      THEME_REMOVAL_MIGRATION,
      USERNAME_REMOVAL_MIGRATION,
      EMAIL_TWO_FACTOR_MIGRATION
    ])
  })

  it("新旧账本同存 → 409 LEDGER_CONFLICT，一个表都不动", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    db.db.exec(
      `CREATE TABLE ${legacyMigrationsTable(prefix)} (name TEXT PRIMARY KEY)`
    )
    const before = tableNames(db)

    const result = await runSetup(env)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe("LEDGER_CONFLICT")
      expect(result.error).toContain(legacyMigrationsTable(prefix))
    }
    expect(tableNames(db)).toEqual(before)
    expect(tableNames(db)).toContain(legacyMigrationsTable(prefix))
  })

  it("旧账本没有 name 列（别人的表）→ 409，绝不改名", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const legacy = legacyMigrationsTable(prefix)
    db.db.exec(`ALTER TABLE ${migrationsTable(prefix)} RENAME TO ${legacy}`)
    db.db.exec(`ALTER TABLE ${legacy} RENAME TO ${legacy}_old`)
    db.db.exec(`CREATE TABLE ${legacy} (id TEXT PRIMARY KEY)`)

    const result = await runSetup(env)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe("LEDGER_CONFLICT")
    }
    expect(
      db.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
        )
        .get(legacy)
    ).toBeTruthy()
    expect(tableNames(db)).not.toContain(migrationsTable(prefix))
    expect(tableNames(db)).toContain(usersTable(prefix))
    expect(tableNames(db)).toContain(settingsTable(prefix))
    expect(tableNames(db)).toContain(sessionsTable(prefix))
  })
})

describe("schema_v5：删除 users.username", () => {
  /** 表当前的列名（按表定义顺序）。 */
  function columnNames(db: SqliteD1, table: string): string[] {
    return db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>()
      .map((column) => column.name)
  }

  /** 用户名部分唯一索引是否还在。 */
  function hasUsernameIndex(db: SqliteD1, prefix: string): boolean {
    return (
      db.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`
        )
        .get(indexName(prefix, "users_username")) !== undefined
    )
  }

  it("全新库：schema_v2 建出的 username 列与部分唯一索引被 schema_v5 删除", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    expect(columnNames(db, usersTable(prefix))).not.toContain("username")
    expect(hasUsernameIndex(db, prefix)).toBe(false)
  })

  it("存量库删列：索引先删、行与邮箱唯一约束保留、旧设置行清掉，二次 setup 幂等", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const table = usersTable(prefix)
    const now = new Date().toISOString()

    // 还原成「只跑过 v4」的存量库：补回 v2 的列与部分唯一索引，写入带用户名的行，
    // 预置旧资料锁设置行，删掉 v5 账本记录。
    db.db.exec(
      `ALTER TABLE ${table} ADD COLUMN username TEXT NOT NULL DEFAULT ''`
    )
    db.db.exec(`CREATE UNIQUE INDEX ${indexName(prefix, "users_username")}
      ON ${table}(username COLLATE NOCASE) WHERE username <> ''`)
    db.db
      .prepare(
        `INSERT INTO ${table}
          (email, password_hash, role, status, email_verified, language,
           display_name, username, timezone, created_at, updated_at)
         VALUES (?, 'hash', 'user', 'active', 1, 'zh', 'Legacy', 'owner', 'Asia/Shanghai', ?, ?)`
      )
      .run("legacy@example.test", now, now)
    db.db
      .prepare(
        `INSERT INTO ${settingsTable(prefix)} (key, value, updated_at) VALUES (?, ?, ?)`
      )
      .run("profile_username_locked", "true", now)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(USERNAME_REMOVAL_MIGRATION)
    expect(columnNames(db, table)).toContain("username")
    expect(hasUsernameIndex(db, prefix)).toBe(true)

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "applied" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }

    // 列与索引都没了，其余字段原样保留，邮箱唯一约束仍生效。
    expect(columnNames(db, table)).not.toContain("username")
    expect(hasUsernameIndex(db, prefix)).toBe(false)
    expect(
      db.db
        .prepare(
          `SELECT email, display_name, language FROM ${table} WHERE email = ?`
        )
        .get("legacy@example.test")
    ).toEqual({
      email: "legacy@example.test",
      display_name: "Legacy",
      language: "zh"
    })
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO ${table}
            (email, password_hash, role, status, email_verified, language,
             display_name, timezone, created_at, updated_at)
           VALUES ('legacy@example.test', 'hash', 'user', 'active', 1, 'zh',
             'Dup', 'Asia/Shanghai', ?, ?)`
        )
        .run(now, now)
    ).toThrow(/UNIQUE/i)

    // 旧资料锁设置行随迁移删除。
    expect(
      db.db
        .prepare(`SELECT value FROM ${settingsTable(prefix)} WHERE key = ?`)
        .get("profile_username_locked")
    ).toBeUndefined()

    // 二次 setup：全部 skipped，不重复删列。
    const again = await runSetup(env)
    expect(again.success).toBe(true)
    if (again.success) {
      expect(again.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }
  })

  it("删列成功、账本未记的中断：重跑只补记录，不报 no such column", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(USERNAME_REMOVAL_MIGRATION)

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "applied" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }
    expect(columnNames(db, usersTable(prefix))).not.toContain("username")
  })
})

describe("schema_v3：users.must_change_password", () => {
  /** 表当前的列名（按表定义顺序）。 */
  function columnNames(db: SqliteD1, table: string): string[] {
    return db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>()
      .map((column) => column.name)
  }

  it("存量库补列：默认 0，已有行不受影响", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const table = usersTable(prefix)

    // 一条升级前就在的用户：只写 v2 已有的列，不写 must_change_password。
    const now = new Date().toISOString()
    db.db
      .prepare(
        `INSERT INTO ${table}
          (email, password_hash, role, status, email_verified, language,
           display_name, timezone, created_at, updated_at)
         VALUES (?, 'hash', 'user', 'active', 1, 'zh', 'Legacy', 'Asia/Shanghai', ?, ?)`
      )
      .run("legacy@example.test", now, now)

    // 还原成「只跑过 schema_v2」的存量库：删列与账本记录。
    db.db.exec(`ALTER TABLE ${table} DROP COLUMN must_change_password`)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(MUST_CHANGE_PASSWORD_MIGRATION)
    expect(columnNames(db, table)).not.toContain("must_change_password")

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "applied" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }

    // 列补上了，存量行读作 0（不强制改密）。
    expect(columnNames(db, table)).toContain("must_change_password")
    const row = db.db
      .prepare(
        `SELECT email, must_change_password FROM ${table} WHERE email = ?`
      )
      .get("legacy@example.test")
    expect(row).toEqual({
      email: "legacy@example.test",
      must_change_password: 0
    })
  })

  it("列已加、账本未记的中断：重跑只补记录，不报 duplicate column", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)

    // 模拟 prepare 成功、记账失败后的状态：列留、账本记录不在。
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(MUST_CHANGE_PASSWORD_MIGRATION)

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "applied" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }
  })
})

describe("schema_v4：users.theme", () => {
  /** 表当前的列名（按表定义顺序）。 */
  function columnNames(db: SqliteD1, table: string): string[] {
    return db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>()
      .map((column) => column.name)
  }

  it("全新库：schema_v1 建出的 theme 列被 schema_v4 删除", async () => {
    const { env, db } = await initializedContext()
    expect(columnNames(db, usersTable(activePrefix(env)))).not.toContain(
      "theme"
    )
  })

  it("存量库删列：数据保留、邮箱唯一约束不受影响，二次 setup 幂等", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const table = usersTable(prefix)
    const now = new Date().toISOString()

    // 还原成「只跑过 v3」的存量库：加回 theme 列、写入带主题的行、删 v4 账本记录。
    db.db.exec(
      `ALTER TABLE ${table} ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'`
    )
    db.db
      .prepare(
        `INSERT INTO ${table}
          (email, password_hash, role, status, email_verified, language,
           display_name, timezone, theme, created_at, updated_at)
         VALUES (?, 'hash', 'user', 'active', 1, 'zh', 'Legacy', 'Asia/Shanghai', 'dark', ?, ?)`
      )
      .run("legacy@example.test", now, now)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(THEME_REMOVAL_MIGRATION)
    expect(columnNames(db, table)).toContain("theme")

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "applied" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }

    // 列删了，其余字段原样保留。
    expect(columnNames(db, table)).not.toContain("theme")
    expect(
      db.db
        .prepare(
          `SELECT email, display_name, language FROM ${table} WHERE email = ?`
        )
        .get("legacy@example.test")
    ).toEqual({
      email: "legacy@example.test",
      display_name: "Legacy",
      language: "zh"
    })

    // 二次 setup：v4 已记账，全部 skipped，不重复删列。
    const again = await runSetup(env)
    expect(again.success).toBe(true)
    if (again.success) {
      expect(again.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "skipped" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }
  })

  it("删列成功、账本未记的中断：重跑只补记录，不报 no such column", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(THEME_REMOVAL_MIGRATION)

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "skipped" },
        { name: MUST_CHANGE_PASSWORD_MIGRATION, status: "skipped" },
        { name: THEME_REMOVAL_MIGRATION, status: "applied" },
        { name: USERNAME_REMOVAL_MIGRATION, status: "skipped" },
        { name: EMAIL_TWO_FACTOR_MIGRATION, status: "skipped" }
      ])
    }
    expect(columnNames(db, usersTable(prefix))).not.toContain("theme")
  })
})
