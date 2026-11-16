/**
 * 迁移的唯一定义处：结构坍缩后的基线 `schema_v1`，其后按序追加。
 *
 * - 全新库：`schema_v1` 的 sql 按 schema.ts 的定版 DDL 一次建出全部表/索引，
 *   随后的 `schema_v2` 起在其上叠加。
 * - 重复执行：全部 `CREATE … IF NOT EXISTS`，幂等空操作（账本已记账时直接 skipped）。
 * - 今后结构变化继续从 `schema_v3` 往后追加；`schema_v1` 不得改名、改内容或调序。
 * - 追加迁移的加列动作放 `prepare`（PRAGMA 判断后再 ALTER），保证「执行到一半失败」
 *   时重跑不会卡在 duplicate column；`sql` 只放可重复执行的语句。
 *
 * 语句之间用 `;` 分隔，语句内部不得出现 `;`（含字符串字面量）。
 * 表名/索引名一律经 tables.ts（基线迁移经 schema.ts 的 `{prefix}` 占位）拼装，不写死前缀。
 */
import { SCHEMA_INDEXES, SCHEMA_TABLES, baselineStatements } from "./schema"
import { indexName, tableName, usersTable } from "./tables"

/** 迁移执行时能拿到的东西：库与生效前缀。 */
export interface MigrationContext {
  db: D1Database
  prefix: string
}

export interface Migration {
  name: string
  sql: string
  /** 在 sql 之前执行的幂等补齐（存量升级用）；基线迁移不需要。 */
  prepare?: (ctx: MigrationContext) => Promise<void>
}

/** 唯一基线迁移名。追加迁移从 schema_v2 起，不改这一条。 */
export const BASELINE_MIGRATION = "schema_v1"

/** 用户名迁移名：给 users 加 `username` 列与部分唯一索引。 */
export const USERNAME_MIGRATION = "schema_v2"

/** 首登强制改密迁移名：给 users 加 `must_change_password` 列。 */
export const MUST_CHANGE_PASSWORD_MIGRATION = "schema_v3"

/**
 * `users.username`（可自定义的用户名，`''` = 未设置）。
 *
 * - 加列走 `prepare`：先看 PRAGMA 再 ALTER，列已在时跳过（幂等，重跑不报 duplicate column）。
 * - 唯一性用**部分**唯一索引：不回填存量数据，存量行全是 `''`，普通 UNIQUE 建索引时
 *   就会因多行 `''` 失败。`''` 参与不了索引，等于「未设置」不占名。
 * - `COLLATE NOCASE` 让 Alice / alice 视为同名（只折叠 ASCII，CJK 无大小写不受影响）。
 * - 回滚：`DROP INDEX`；新增列留着对旧代码无副作用。
 */
function usernameMigration(prefix: string): Migration {
  const table = usersTable(prefix)
  const index = indexName(prefix, "users_username")
  return {
    name: USERNAME_MIGRATION,
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS ${index}
  ON ${table}(username COLLATE NOCASE) WHERE username <> ''`,
    prepare: async (ctx) => {
      const columns = await ctx.db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>()
      if (columns.results.some((column) => column.name === "username")) return
      await ctx.db
        .prepare(
          `ALTER TABLE ${table} ADD COLUMN username TEXT NOT NULL DEFAULT ''`
        )
        .run()
    }
  }
}

/**
 * `users.must_change_password`（管理员建号的首次强制改密标记，0/1）。
 *
 * - 加列走 `prepare`：先看 PRAGMA 再 ALTER，列已在时跳过（幂等，重跑不报 duplicate column）。
 * - 无索引诉求，`sql` 留空（执行器对空 sql 幂等跳过）。
 * - 回滚：加列对旧代码无副作用（默认 0），无需专门回滚动作。
 */
function mustChangePasswordMigration(prefix: string): Migration {
  const table = usersTable(prefix)
  return {
    name: MUST_CHANGE_PASSWORD_MIGRATION,
    sql: "",
    prepare: async (ctx) => {
      const columns = await ctx.db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>()
      if (
        columns.results.some((column) => column.name === "must_change_password")
      ) {
        return
      }
      await ctx.db
        .prepare(
          `ALTER TABLE ${table} ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`
        )
        .run()
    }
  }
}

export function getMigrations(prefix: string): Migration[] {
  const statements = baselineStatements(prefix)
  const sql = statements.join(";\n\n")

  // 表名统一由 tables.ts 的 helper 提供；这里断言 schema.ts 与它用的是同一套名字
  // （改一处就会在这里暴露）。
  for (const table of SCHEMA_TABLES) {
    const expected = tableName(prefix, table.name)
    if (!sql.includes(expected)) {
      throw new Error(
        `migration ${BASELINE_MIGRATION} is missing table ${expected}`
      )
    }
  }
  for (const ddl of SCHEMA_INDEXES) {
    if (!ddl.includes("{prefix}")) {
      throw new Error("schema index DDL must use the {prefix} placeholder")
    }
  }

  return [
    { name: BASELINE_MIGRATION, sql },
    usernameMigration(prefix),
    mustChangePasswordMigration(prefix)
  ]
}
