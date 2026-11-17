/**
 * 第 4 项（邮箱验证码第二因子）的接口契约：
 *
 * - 启用：`/api/auth/2fa/email/enable/send` 发码 → `/api/auth/2fa/email/enable`
 *   验码生效；邮件未配置 409 `EMAIL_NOT_CONFIGURED`，发送失败 502 `EMAIL_SEND_FAILED`。
 * - 登录第二步：密码步的 `methods` 含 `"email"` → `/api/auth/2fa/email/send` 发码 →
 *   `/api/auth/2fa/verify {method:"email"}` 换会话；错误码 400 `EMAIL_NOT_ENABLED`、
 *   401 `STEP_UP_REQUIRED`、409 `EMAIL_NOT_CONFIGURED`、429 `CODE_COOLDOWN` /
 *   `RATE_LIMITED`（带 `retryAfter`）、502 `EMAIL_SEND_FAILED`。
 * - 停用：`/api/auth/2fa/email/disable` 要复核当前密码（与 TOTP 停用同口径）。
 *
 * 码本身复用既有验证码服务，这里顺带锁住「单次使用」与「用途隔离」：启用用的码
 * 不能拿去登录。
 */
import { TOTP } from "otpauth"
import { afterEach, describe, expect, it } from "vitest"
import { user2faTable } from "../src/lib/tables"
import type { Env } from "../src/types"
import {
  activePrefix,
  clearCounters,
  codeFromEmail,
  configureResend,
  cookieFrom,
  initializedContext,
  loginUser,
  postJson,
  registerAndLogin,
  registerUser,
  request,
  stubResend,
  TEST_PASSWORD,
  writeSetting,
  type FetchStub
} from "./support/app"

const EMAIL = "owner@example.test"

let stub: FetchStub | null = null

afterEach(() => {
  stub?.restore()
  stub = null
})

/** 从响应体里取稳定错误码。 */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { code?: string }
  return body.code ?? ""
}

/** 登录密码步，返回 tempToken（没开第二因子时为空串）。 */
async function passwordStep(env: Env): Promise<string> {
  const res = await loginUser(env, { email: EMAIL })
  const body = (await res.json()) as { tempToken?: string }
  return body.tempToken ?? ""
}

/** 走完启用流程（需先配好邮件通道并装好 stub），返回用掉的码。 */
async function enableEmailFactor(
  env: Env,
  cookie: string,
  activeStub: FetchStub
): Promise<string> {
  const send = await postJson(
    env,
    "/api/auth/2fa/email/enable/send",
    {},
    { cookie }
  )
  expect(send.status).toBe(200)
  const code = codeFromEmail(activeStub.sent.at(-1))
  const enable = await postJson(
    env,
    "/api/auth/2fa/email/enable",
    { code },
    { cookie }
  )
  expect(enable.status).toBe(200)
  return code
}

/** 直接开 TOTP：给「密码步照常发 tempToken，但没开邮箱因子」的用例用。 */
async function enableTotp(env: Env, cookie: string): Promise<void> {
  const setup = await request(env, "/api/auth/2fa/totp/setup", {
    method: "POST",
    headers: { cookie }
  })
  expect(setup.status).toBe(200)
  const { secret } = (await setup.json()) as { secret: string }
  const enable = await postJson(
    env,
    "/api/auth/2fa/totp/enable",
    {
      code: new TOTP({
        secret,
        digits: 6,
        period: 30,
        algorithm: "SHA1"
      }).generate()
    },
    { cookie }
  )
  expect(enable.status).toBe(200)
}

describe("启用邮箱第二因子", () => {
  it("邮件未配置时不许启用：409 EMAIL_NOT_CONFIGURED，开关保持关闭", async () => {
    const { env } = await initializedContext()
    await registerUser(env, { email: EMAIL })
    const cookie = cookieFrom(await loginUser(env, { email: EMAIL }))

    const me = (await (
      await request(env, "/api/me", { headers: { cookie } })
    ).json()) as { emailTwoFactorEnabled: boolean }
    expect(me.emailTwoFactorEnabled).toBe(false)

    const res = await postJson(
      env,
      "/api/auth/2fa/email/enable/send",
      {},
      { cookie }
    )
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("EMAIL_NOT_CONFIGURED")

    // 已登录侧端点不公开：没有会话就是 401。
    const anonymous = await postJson(env, "/api/auth/2fa/email/enable/send", {})
    expect(anonymous.status).toBe(401)
  })

  it("发码到本人邮箱，错码 400、对码生效，Me 反映 emailTwoFactorEnabled", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    stub = stubResend()
    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    configureResend(db, prefix)

    const send = await postJson(
      env,
      "/api/auth/2fa/email/enable/send",
      {},
      { cookie }
    )
    expect(send.status).toBe(200)
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0].to).toBe(EMAIL)
    const code = codeFromEmail(stub.sent[0])

    const wrong = await postJson(
      env,
      "/api/auth/2fa/email/enable",
      { code: code === "000000" ? "000001" : "000000" },
      { cookie }
    )
    expect(wrong.status).toBe(400)
    expect(await errorCode(wrong)).toBe("INVALID_CODE")

    const enable = await postJson(
      env,
      "/api/auth/2fa/email/enable",
      { code },
      { cookie }
    )
    expect(enable.status).toBe(200)

    const me = (await (
      await request(env, "/api/me", { headers: { cookie } })
    ).json()) as { emailTwoFactorEnabled: boolean }
    expect(me.emailTwoFactorEnabled).toBe(true)
    expect(
      db.db.prepare(`SELECT email_enabled FROM ${user2faTable(prefix)}`).get()
    ).toEqual({ email_enabled: 1 })

    // 已启用后再发启用码：409，不重复进启用流程。
    const again = await postJson(
      env,
      "/api/auth/2fa/email/enable/send",
      {},
      { cookie }
    )
    expect(again.status).toBe(409)
    expect(await errorCode(again)).toBe("EMAIL_ALREADY_ENABLED")
  })
})

describe("登录第二步：邮箱验证码", () => {
  it("methods 含 email；发码 → 验码换会话；启用用的码不能拿去登录", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    stub = stubResend()
    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    configureResend(db, prefix)
    const enableCode = await enableEmailFactor(env, cookie, stub)

    const stepRes = await loginUser(env, { email: EMAIL })
    const stepBody = (await stepRes.json()) as {
      requires2fa: boolean
      tempToken: string
      methods: string[]
    }
    expect(stepBody.requires2fa).toBe(true)
    expect(stepBody.methods).toEqual(["email"])

    // 用途隔离 + 单次使用：启用时核销的那枚码在登录步不认。
    const reused = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: stepBody.tempToken,
      method: "email",
      code: enableCode
    })
    expect(reused.status).toBe(400)
    expect(await errorCode(reused)).toBe("INVALID_CODE")

    // 启用发码与登录发码共用冷却键：清掉后再发，等价于「隔了 60 秒」。
    clearCounters(db, prefix, "code_cooldown:twofa_email")
    const send = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: stepBody.tempToken
    })
    expect(send.status).toBe(200)
    expect(await send.json()).toEqual({ success: true })
    expect(stub.sent.at(-1)?.to).toBe(EMAIL)
    const code = codeFromEmail(stub.sent.at(-1))

    const verified = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: stepBody.tempToken,
      method: "email",
      code
    })
    expect(verified.status).toBe(200)
    const verifiedBody = (await verified.json()) as {
      success: boolean
      user: { emailTwoFactorEnabled: boolean }
    }
    expect(verifiedBody.success).toBe(true)
    expect(verifiedBody.user.emailTwoFactorEnabled).toBe(true)
    expect(cookieFrom(verified).startsWith("session=")).toBe(true)

    // tempToken 用后作废。
    const replay = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: stepBody.tempToken,
      method: "email",
      code
    })
    expect(replay.status).toBe(401)
    expect(await errorCode(replay)).toBe("STEP_UP_REQUIRED")
  })

  it("未启用 400 EMAIL_NOT_ENABLED；配置被清空 409；发送失败 502", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    stub = stubResend()
    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    configureResend(db, prefix)

    // 只开了 TOTP 的账号：密码步照常发 tempToken，但没有邮箱因子。
    await enableTotp(env, cookie)
    const notEnabled = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: await passwordStep(env)
    })
    expect(notEnabled.status).toBe(400)
    expect(await errorCode(notEnabled)).toBe("EMAIL_NOT_ENABLED")

    await enableEmailFactor(env, cookie, stub)
    clearCounters(db, prefix, "code_cooldown:twofa_email")

    // 站点把邮件通道撤了：不能再发（不静默吞掉）。
    writeSetting(db, prefix, "email_provider", "none")
    const notConfigured = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: await passwordStep(env)
    })
    expect(notConfigured.status).toBe(409)
    expect(await errorCode(notConfigured)).toBe("EMAIL_NOT_CONFIGURED")

    // 通道在但发送失败：502，用户如实知道没收到码。
    configureResend(db, prefix)
    stub.restore()
    stub = stubResend({ fail: { status: 500, body: "smtp down" } })
    clearCounters(db, prefix, "code_cooldown:twofa_email")
    const failed = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: await passwordStep(env)
    })
    expect(failed.status).toBe(502)
    expect(await errorCode(failed)).toBe("EMAIL_SEND_FAILED")
  })

  it("60 秒冷却 429 CODE_COOLDOWN（带 retryAfter），超次数按 IP 429 RATE_LIMITED", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    stub = stubResend()
    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    configureResend(db, prefix)
    await enableEmailFactor(env, cookie, stub)
    clearCounters(db, prefix, "code_cooldown:twofa_email")

    const statuses: Array<{
      status: number
      code: string
      retryAfter: number
    }> = []
    // 限流 5 次 / 5 分钟：第 1 次成功，第 2~5 次被冷却拦（仍计数），第 6 次 429 限流。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await postJson(env, "/api/auth/2fa/email/send", {
        tempToken: await passwordStep(env)
      })
      const body = (await res.json()) as {
        code?: string
        retryAfter?: number
      }
      statuses.push({
        status: res.status,
        code: body.code ?? "",
        retryAfter: body.retryAfter ?? 0
      })
    }

    expect(statuses[0]).toEqual({ status: 200, code: "", retryAfter: 0 })
    for (const entry of statuses.slice(1, 5)) {
      expect(entry.status).toBe(429)
      expect(entry.code).toBe("CODE_COOLDOWN")
      expect(entry.retryAfter).toBeGreaterThan(0)
    }
    expect(statuses[5].status).toBe(429)
    expect(statuses[5].code).toBe("RATE_LIMITED")
    expect(statuses[5].retryAfter).toBeGreaterThan(0)
    // 只有第一次真的发了信：1 封启用码 + 1 封登录码。
    expect(stub.sent).toHaveLength(2)
  })
})

describe("停用邮箱第二因子", () => {
  it("要复核当前密码；停用后登录不再要求第二因子", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    stub = stubResend()
    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    configureResend(db, prefix)
    await enableEmailFactor(env, cookie, stub)

    const missing = await postJson(
      env,
      "/api/auth/2fa/email/disable",
      {},
      { cookie }
    )
    expect(missing.status).toBe(400)
    expect(await errorCode(missing)).toBe("PASSWORD_INCORRECT")

    const wrong = await postJson(
      env,
      "/api/auth/2fa/email/disable",
      { password: "not-the-password" },
      { cookie }
    )
    expect(wrong.status).toBe(403)
    expect(await errorCode(wrong)).toBe("PASSWORD_INCORRECT")

    const disabled = await postJson(
      env,
      "/api/auth/2fa/email/disable",
      { password: TEST_PASSWORD },
      { cookie }
    )
    expect(disabled.status).toBe(200)

    const me = (await (
      await request(env, "/api/me", { headers: { cookie } })
    ).json()) as { emailTwoFactorEnabled: boolean }
    expect(me.emailTwoFactorEnabled).toBe(false)
    expect(
      db.db.prepare(`SELECT email_enabled FROM ${user2faTable(prefix)}`).get()
    ).toEqual({ email_enabled: 0 })

    const login = await loginUser(env, { email: EMAIL })
    const body = (await login.json()) as Record<string, unknown>
    expect("requires2fa" in body).toBe(false)
    expect(body.success).toBe(true)
    expect(cookieFrom(login).startsWith("session=")).toBe(true)
  })
})
