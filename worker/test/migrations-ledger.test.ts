/**
 * 规格 §7-2：迁移账本命名（带前导下划线）与旧账本改名承接。
 * 顺带锁住两条硬约束：基线语句内部不得出现 `;`、表名一律由 tables.ts 拼装。
 */
import { describe, expect, it } from "vitest"
import {
  BASELINE_MIGRATION,
  USERNAME_MIGRATION,
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
  it("基线 schema_v1 后追加 schema_v2，语句内部不含分号", () => {
    const prefix = "wiki_"
    const migrations = getMigrations(prefix)
    expect(migrations.map((migration) => migration.name)).toEqual([
      BASELINE_MIGRATION,
      USERNAME_MIGRATION
    ])
    for (const migration of migrations) {
      const statements = splitStatements(migration.sql)
      expect(statements.length).toBeGreaterThan(0)
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
        { name: USERNAME_MIGRATION, status: "skipped" }
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
        { name: USERNAME_MIGRATION, status: "skipped" }
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
      USERNAME_MIGRATION
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

describe("schema_v2：users.username", () => {
  /** 把已升级的库还原成「只跑过 schema_v1」的存量库（删 v2 产物与账本记录）。 */
  function downgradeToBaseline(db: SqliteD1, prefix: string): void {
    db.db.exec(`DROP INDEX ${indexName(prefix, "users_username")}`)
    db.db.exec(`ALTER TABLE ${usersTable(prefix)} DROP COLUMN username`)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(USERNAME_MIGRATION)
  }

  /** 表当前的列名（按表定义顺序）。 */
  function columnNames(db: SqliteD1, table: string): string[] {
    return db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>()
      .map((column) => column.name)
  }

  it("存量库补列与唯一索引：schema_v2 applied，已有行不受影响", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const table = usersTable(prefix)

    // 一条「升级前」就在的用户：只写 v1 有的列。
    const now = new Date().toISOString()
    db.db
      .prepare(
        `INSERT INTO ${table}
          (email, password_hash, role, status, email_verified, language,
           display_name, timezone, theme, created_at, updated_at)
         VALUES (?, 'hash', 'user', 'active', 1, 'zh', 'Legacy', 'Asia/Shanghai', 'system', ?, ?)`
      )
      .run("legacy@example.test", now, now)

    downgradeToBaseline(db, prefix)
    expect(columnNames(db, table)).not.toContain("username")

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "applied" }
      ])
    }

    expect(columnNames(db, table)).toContain("username")

    const row = db.db
      .prepare(
        `SELECT email, display_name, username FROM ${table} WHERE email = ?`
      )
      .get("legacy@example.test")
    expect(row).toEqual({
      email: "legacy@example.test",
      display_name: "Legacy",
      username: ""
    })

    const index = db.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`)
      .get(indexName(prefix, "users_username"))
    expect(index).toBeTruthy()

    // 存量行不加名也能并存（部分唯一索引），名字重复则由索引拒绝。
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO ${table}
            (email, password_hash, role, status, email_verified, language,
             display_name, username, timezone, theme, created_at, updated_at)
           VALUES ('second@example.test', 'hash', 'user', 'active', 1, 'zh',
             '', '', 'Asia/Shanghai', 'system', ?, ?)`
        )
        .run(now, now)
    ).not.toThrow()
    expect(() =>
      db.db
        .prepare(
          `UPDATE ${table} SET username = 'owner' WHERE email = 'legacy@example.test'`
        )
        .run()
    ).not.toThrow()
    expect(() =>
      db.db
        .prepare(
          `UPDATE ${table} SET username = 'Owner' WHERE email = 'second@example.test'`
        )
        .run()
    ).toThrow(/UNIQUE/i)
  })

  it("列已加、索引未建的中断：重跑只补索引，不报 duplicate column", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)

    // 模拟 prepare 成功、sql 失败后的状态：列留、索引与账本记录都不在。
    db.db.exec(`DROP INDEX ${indexName(prefix, "users_username")}`)
    db.db
      .prepare(`DELETE FROM ${migrationsTable(prefix)} WHERE name = ?`)
      .run(USERNAME_MIGRATION)

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: USERNAME_MIGRATION, status: "applied" }
      ])
    }
    expect(
      db.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`
        )
        .get(indexName(prefix, "users_username"))
    ).toBeTruthy()
  })
})
