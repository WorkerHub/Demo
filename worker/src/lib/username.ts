/**
 * 用户名的唯一校验处：形状规则只写这一份，路由与测试共用，前端单按同一组数字实现。
 *
 * - `''` = 未设置（存量用户与新注册用户都是）；`normalizeUsername` 拒绝写入空值，
 *   所以一个人设了名之后不能清空。
 * - 2–20 个码点，首字符必须是字母或数字，其余允许字母、数字、`_`、`-`。
 *   `\p{L}` 覆盖中日韩文字，所以中文用户名合法；空格与符号一律不接受。
 * - 大小写不敏感的唯一性由库层的部分唯一索引兜底（迁移 `schema_v2`），这里只管形状。
 */
export const USERNAME_MIN_LENGTH = 2
export const USERNAME_MAX_LENGTH = 20

const USERNAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u

/** 合法则返回 trim 后的用户名，否则 null（调用方回 400 INVALID_USERNAME）。 */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null
  const username = value.trim()
  const length = Array.from(username).length
  if (length < USERNAME_MIN_LENGTH || length > USERNAME_MAX_LENGTH) return null
  if (!USERNAME_PATTERN.test(username)) return null
  return username
}
