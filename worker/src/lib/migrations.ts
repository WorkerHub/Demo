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
import {
  emailCodesTable,
  indexName,
  settingsTable,
  tableName,
  user2faTable,
  usersTable
} from "./tables"

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

/** 主题剥离迁移名：把 theme 从用户属性里删掉（主题只存前端 localStorage）。 */
export const THEME_REMOVAL_MIGRATION = "schema_v4"

/** 用户名退役迁移名：删 `users.username` 列、部分唯一索引与资料锁设置行。 */
export const USERNAME_REMOVAL_MIGRATION = "schema_v5"

/** 邮箱第二因子迁移名：`user_2fa.email_enabled` 与验证码用途 `twofa_email`。 */
export const EMAIL_2FA_MIGRATION = "schema_v6"

/**
 * `users.username`（可自定义的用户名，`''` = 未设置）。
 *
 * - 加列走 `prepare`：先看 PRAGMA 再 ALTER，列已在时跳过（幂等，重跑不报 duplicate column）。
 * - 唯一性用**部分**唯一索引：不回填存量数据，存量行全是 `''`，普通 UNIQUE 建索引时
 *   就会因多行 `''` 失败。`''` 参与不了索引，等于「未设置」不占名。
 * - `COLLATE NOCASE` 让 Alice / alice 视为同名（只折叠 ASCII，CJK 无大小写不受影响）。
 * - 回滚：`DROP INDEX`；新增列留着对旧代码无副作用。
 * - 本迁移的产物已由 `schema_v5` 撤销（删列与索引）；保留它只为账本连续可重放。
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

/**
 * `users.theme` 退役（主题只存前端，不进用户属性）。
 *
 * - 删列走 `prepare`：先看 PRAGMA，列在才 DROP，重跑/中断重跑都幂等。
 * - 无索引诉求，`sql` 留空（执行器对空 sql 幂等跳过）。
 * - 全新库仍由冻结的 `schema_v1` 建出该列，本迁移紧接着删掉，两条路径收敛到同一形状。
 * - 执行顺序（硬约束）：必须等本版本部署完成后再触发升级。Cloudflare 部署传播期间
 *   边缘仍可能跑删列前的旧版本，而旧版本会 `SELECT theme`，此时删列会让那些位置报缺列。
 * - 回滚 Worker 到删列前的版本前，先补回列（`ADD COLUMN theme TEXT NOT NULL DEFAULT
 *   'system'`），否则旧代码读缺列直接报错；原值不可恢复，要取值只能靠 D1 Time Travel，
 *   所以执行前必须先备份。
 */
function themeRemovalMigration(prefix: string): Migration {
  const table = usersTable(prefix)
  return {
    name: THEME_REMOVAL_MIGRATION,
    sql: "",
    prepare: async (ctx) => {
      const columns = await ctx.db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>()
      if (columns.results.some((column) => column.name === "theme")) {
        await ctx.db.prepare(`ALTER TABLE ${table} DROP COLUMN theme`).run()
      }
    }
  }
}

/**
 * `users.username` 退役（昵称是唯一名字字段）。
 *
 * - 删列走 `prepare`：先看 PRAGMA，列在才 DROP，重跑/中断重跑都幂等（`DROP COLUMN`
 *   本身不幂等，重跑会报 no such column）。
 * - 顺序硬约束：SQLite 不允许删被索引引用的列（报 "error in index … after drop column"），
 *   必须先 `DROP INDEX IF EXISTS` 掉 `schema_v2` 建的部分唯一索引。
 * - `sql` 清理旧资料锁的设置行（可重复执行）。
 * - 全新库：`schema_v2` 建列与索引，本迁移紧接着删掉，两条路径收敛到同一形状。
 * - 回滚：补回列（`ADD COLUMN username TEXT NOT NULL DEFAULT ''`）与部分唯一索引即可让
 *   旧代码运行；每行原值不可恢复（只能靠 D1 Time Travel）。规格已定 Demo 数据可弃。
 */
function usernameRemovalMigration(prefix: string): Migration {
  const table = usersTable(prefix)
  const index = indexName(prefix, "users_username")
  return {
    name: USERNAME_REMOVAL_MIGRATION,
    sql: `DELETE FROM ${settingsTable(prefix)} WHERE key = 'profile_username_locked'`,
    prepare: async (ctx) => {
      const columns = await ctx.db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>()
      if (!columns.results.some((column) => column.name === "username")) return
      await ctx.db.prepare(`DROP INDEX IF EXISTS ${index}`).run()
      await ctx.db.prepare(`ALTER TABLE ${table} DROP COLUMN username`).run()
    }
  }
}

/**
 * 邮箱第二因子：`user_2fa.email_enabled` 与验证码用途 `twofa_email`。
 *
 * - 加列走 `prepare`：先看 PRAGMA 再 ALTER，重跑不报 duplicate column。
 * - `email_verification_codes.purpose` 的 CHECK 只能重建表（SQLite 不支持改 CHECK）：
 *   建新表 → 按 id 原样搬数据 → 删旧表 → 改名 → 重建两条索引，整段放进一个
 *   `db.batch` 事务，失败整体回滚；重跑按 `sqlite_master` 的建表 SQL 判断是否已完成。
 * - 全新库与存量库收敛到同一形状：基线仍建旧 CHECK 的表，本迁移紧接着重建。
 * - 执行顺序：本迁移对旧代码兼容（列只增、旧 purpose 仍合法），但新版本代码会读
 *   `email_enabled`，必须先部署新版本、再由用户点「检查并升级数据库」；部署到升级
 *   之间 `db/queries/twofa.ts` 对缺列按未启用兜底，登录不受影响。
 * - 回滚：回滚 Worker 无需撤销本迁移（旧代码忽略新列、旧 purpose 仍合法）。彻底撤销
 *   才需先删除 `purpose = 'twofa_email'` 的行，再按同样方式重建两表并去掉列；
 *   执行前必须备份（D1 Time Travel）。
 */
function emailTwoFactorMigration(prefix: string): Migration {
  const twofa = user2faTable(prefix)
  const codes = emailCodesTable(prefix)
  const temp = `${codes}__v6`
  return {
    name: EMAIL_2FA_MIGRATION,
    sql: "",
    prepare: async (ctx) => {
      const columns = await ctx.db
        .prepare(`PRAGMA table_info(${twofa})`)
        .all<{ name: string }>()
      if (!columns.results.some((column) => column.name === "email_enabled")) {
        await ctx.db
          .prepare(
            `ALTER TABLE ${twofa} ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0`
          )
          .run()
      }

      const table = await ctx.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
        )
        .bind(codes)
        .first<{ sql: string }>()
      if (!table) {
        throw new Error(`table ${codes} is missing; run schema_v1 first`)
      }
      if (table.sql.includes("'twofa_email'")) return

      await ctx.db.batch([
        ctx.db.prepare(`DROP TABLE IF EXISTS ${temp}`),
        ctx.db.prepare(
          `CREATE TABLE ${temp} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('register_verify', 'password_reset', 'twofa_email')),
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
)`
        ),
        ctx.db.prepare(
          `INSERT INTO ${temp}
            (id, email, purpose, code_hash, expires_at, attempts, used_at, created_at)
           SELECT id, email, purpose, code_hash, expires_at, attempts, used_at, created_at
             FROM ${codes}`
        ),
        ctx.db.prepare(`DROP TABLE ${codes}`),
        ctx.db.prepare(`ALTER TABLE ${temp} RENAME TO ${codes}`),
        ctx.db.prepare(
          `CREATE INDEX IF NOT EXISTS ${indexName(prefix, "email_codes_lookup")}
             ON ${codes}(email, purpose, created_at)`
        ),
        ctx.db.prepare(
          `CREATE INDEX IF NOT EXISTS ${indexName(prefix, "email_codes_expires")}
             ON ${codes}(expires_at)`
        )
      ])
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
    mustChangePasswordMigration(prefix),
    themeRemovalMigration(prefix),
    usernameRemovalMigration(prefix),
    emailTwoFactorMigration(prefix)
  ]
}
