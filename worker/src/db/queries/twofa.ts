/**
 * `user_2fa` 的读写：TOTP 状态。密钥列只在该用户自己的 setup 响应里出现一次，
 * 其余任何 DTO 都不返回它。
 */
import { user2faTable } from "../../lib/tables"

export interface TwoFactorRow {
  user_id: number
  totp_secret: string | null
  totp_enabled: number
  email_enabled: number
  updated_at: string
}

const COLUMNS = "user_id, totp_secret, totp_enabled, updated_at"
const COLUMNS_WITH_EMAIL =
  "user_id, totp_secret, totp_enabled, email_enabled, updated_at"

export async function getTwoFactor(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<TwoFactorRow | null> {
  const table = user2faTable(prefix)

  try {
    return await db
      .prepare(`SELECT ${COLUMNS_WITH_EMAIL} FROM ${table} WHERE user_id = ?`)
      .bind(userId)
      .first<TwoFactorRow>()
  } catch (err) {
    // 新版本已部署、用户还没点「检查并升级数据库」：列不存在时按未启用处理。
    // 此刻还没有账号能启用邮箱因子（写接口同样依赖该列），兜底不会绕过因子。
    if (
      !(err instanceof Error) ||
      !/no such column:\s*email_enabled/i.test(err.message)
    ) {
      throw err
    }
    const legacy = await db
      .prepare(`SELECT ${COLUMNS} FROM ${table} WHERE user_id = ?`)
      .bind(userId)
      .first<Omit<TwoFactorRow, "email_enabled">>()
    return legacy ? { ...legacy, email_enabled: 0 } : null
  }
}

export async function upsertTwoFactor(
  db: D1Database,
  prefix: string,
  userId: number,
  patch: { totpSecret?: string | null; totpEnabled: number }
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${user2faTable(prefix)} (user_id, totp_secret, totp_enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         totp_secret = excluded.totp_secret,
         totp_enabled = excluded.totp_enabled,
         updated_at = excluded.updated_at`
    )
    .bind(userId, patch.totpSecret ?? null, patch.totpEnabled, now)
    .run()
}

/** 只翻邮箱因子开关，不覆盖 TOTP 列（TOTP 仍由 upsertTwoFactor 管）。 */
export async function setEmailTwoFactorEnabled(
  db: D1Database,
  prefix: string,
  userId: number,
  enabled: boolean
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${user2faTable(prefix)}
        (user_id, totp_secret, totp_enabled, email_enabled, updated_at)
       VALUES (?, NULL, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email_enabled = excluded.email_enabled,
         updated_at = excluded.updated_at`
    )
    .bind(userId, enabled ? 1 : 0, now)
    .run()
}
