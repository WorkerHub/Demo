/**
 * `user_2fa` 的读写：一行一个用户的第二因子状态（TOTP 密钥/开关、邮箱开关）。
 * 密钥列只在该用户自己的 setup 响应里出现一次，其余任何 DTO 都不返回它。
 *
 * 三种方式各占一列（`totp_enabled` / `email_enabled`，通行密钥在它自己的表里
 * 按行计数），可同时启用；写入时各走各的 helper，互不覆盖。
 */
import { user2faTable } from "../../lib/tables"

export interface TwoFactorRow {
  user_id: number
  totp_secret: string | null
  totp_enabled: number
  email_enabled: number
  updated_at: string
}

export async function getTwoFactor(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<TwoFactorRow | null> {
  return db
    .prepare(
      `SELECT user_id, totp_secret, totp_enabled, email_enabled, updated_at
         FROM ${user2faTable(prefix)} WHERE user_id = ?`
    )
    .bind(userId)
    .first<TwoFactorRow>()
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

/**
 * 邮箱第二因子的开关（`user_2fa.email_enabled`）。只写自己这一列，不动 TOTP 的
 * 密钥与开关——两种方式可以同时启用。
 */
export async function setEmailTwoFactor(
  db: D1Database,
  prefix: string,
  userId: number,
  enabled: boolean
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${user2faTable(prefix)} (user_id, email_enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email_enabled = excluded.email_enabled,
         updated_at = excluded.updated_at`
    )
    .bind(userId, enabled ? 1 : 0, now)
    .run()
}
