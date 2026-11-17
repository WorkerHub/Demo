/**
 * 第4项后端：邮箱第二因子。
 *
 * 覆盖启用（发码 → 验码）→ 登录第二步（显式发码 → 验码）→ 停用闭环，
 * 以及未配置邮件、未启用、冷却、多方式并存、用途隔离与发送失败 502。
 */
import { TOTP } from "otpauth"
import { afterEach, describe, expect, it } from "vitest"
import { issueVerificationCode } from "../src/core/verification-codes"
import { setEmailTwoFactorEnabled } from "../src/db/queries/twofa"
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
  request,
  stubResend,
  TEST_PASSWORD,
  writeSetting,
  type FetchStub
} from "./support/app"

const EMAIL = "twofa@example.test"

type TestEnv = Parameters<typeof request>[0]

let stub: FetchStub | null = null

afterEach(() => {
  stub?.restore()
  stub = null
})

function currentCode(secret: string): string {
  return new TOTP({
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30
  }).generate()
}

async function me(
  env: TestEnv,
  cookie: string
): Promise<{ id: number; emailTwoFactorEnabled: boolean }> {
  const res = await request(env, "/api/me", { headers: { cookie } })
  return (await res.json()) as {
    id: number
    emailTwoFactorEnabled: boolean
  }
}

async function enableEmail(env: TestEnv, cookie: string): Promise<void> {
  const setup = await postJson(env, "/api/auth/2fa/email/setup", {}, { cookie })
  expect(setup.status).toBe(200)
  const code = codeFromEmail(stub?.sent.at(-1))
  const enable = await postJson(
    env,
    "/api/auth/2fa/email/enable",
    { code },
    { cookie }
  )
  expect(enable.status).toBe(200)
}

async function enableTotp(env: TestEnv, cookie: string): Promise<string> {
  const setup = await postJson(env, "/api/auth/2fa/totp/setup", {}, { cookie })
  const { secret } = (await setup.json()) as { secret: string }
  const enable = await postJson(
    env,
    "/api/auth/2fa/totp/enable",
    { code: currentCode(secret) },
    { cookie }
  )
  expect(enable.status).toBe(200)
  return secret
}

async function beginSecondStep(
  env: TestEnv
): Promise<{ tempToken: string; methods: string[] }> {
  const res = await loginUser(env, { email: EMAIL })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    requires2fa: true
    tempToken: string
    methods: string[]
  }
  expect(body.requires2fa).toBe(true)
  return body
}

describe("邮箱第二因子", () => {
  it("启用 → 登录发码/验码 → 停用", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    configureResend(db, prefix)
    stub = stubResend()

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    await enableEmail(env, cookie)
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0].to).toBe(EMAIL)
    expect((await me(env, cookie)).emailTwoFactorEnabled).toBe(true)

    const again = await postJson(
      env,
      "/api/auth/2fa/email/setup",
      {},
      { cookie }
    )
    expect(again.status).toBe(409)
    const againBody = (await again.json()) as { code: string }
    expect(againBody.code).toBe("EMAIL_ALREADY_ENABLED")

    // 密码步不自动发信；第二步显式发码。
    clearCounters(db, prefix)
    const step = await beginSecondStep(env)
    expect(step.methods).toEqual(["email"])
    expect(stub.sent).toHaveLength(1)

    const sent = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: step.tempToken
    })
    expect(sent.status).toBe(200)
    expect(stub.sent).toHaveLength(2)
    const code = codeFromEmail(stub.sent[1])

    const wrong = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: step.tempToken,
      method: "email",
      code: code === "000000" ? "111111" : "000000"
    })
    expect(wrong.status).toBe(400)
    const wrongBody = (await wrong.json()) as { code: string }
    expect(wrongBody.code).toBe("INVALID_CODE")

    const verified = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: step.tempToken,
      method: "email",
      code
    })
    expect(verified.status).toBe(200)
    const verifiedCookie = cookieFrom(verified)
    expect((await me(env, verifiedCookie)).emailTwoFactorEnabled).toBe(true)

    const wrongPassword = await postJson(
      env,
      "/api/auth/2fa/email/disable",
      { password: "nope" },
      { cookie }
    )
    expect(wrongPassword.status).toBe(403)

    const disabled = await postJson(
      env,
      "/api/auth/2fa/email/disable",
      { password: TEST_PASSWORD },
      { cookie }
    )
    expect(disabled.status).toBe(200)
    expect((await me(env, cookie)).emailTwoFactorEnabled).toBe(false)

    const direct = await loginUser(env, { email: EMAIL })
    expect(direct.status).toBe(200)
    expect(await direct.json()).toMatchObject({ success: true })
  })

  it("发码 60 秒冷却，缺 tempToken 回 STEP_UP_REQUIRED", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    configureResend(db, prefix)
    stub = stubResend()

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    await enableEmail(env, cookie)
    clearCounters(db, prefix)

    const step = await beginSecondStep(env)
    const first = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: step.tempToken
    })
    expect(first.status).toBe(200)

    const second = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: step.tempToken
    })
    expect(second.status).toBe(429)
    const body = (await second.json()) as {
      code: string
      retryAfter: number
    }
    expect(body.code).toBe("CODE_COOLDOWN")
    expect(body.retryAfter).toBeGreaterThan(0)

    const anonymous = await postJson(env, "/api/auth/2fa/email/send", {})
    expect(anonymous.status).toBe(401)
    const anonymousBody = (await anonymous.json()) as { code: string }
    expect(anonymousBody.code).toBe("STEP_UP_REQUIRED")
  })

  it("站点未配置邮件时不许启用", async () => {
    const { env } = await initializedContext()
    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    const setup = await postJson(
      env,
      "/api/auth/2fa/email/setup",
      {},
      { cookie }
    )
    expect(setup.status).toBe(409)
    const setupBody = (await setup.json()) as { code: string }
    expect(setupBody.code).toBe("EMAIL_NOT_CONFIGURED")
  })

  it("启用后邮件能力被撤：登录不再要求邮箱因子", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    configureResend(db, prefix)
    stub = stubResend()

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    await enableEmail(env, cookie)
    writeSetting(db, prefix, "email_provider", "none")
    clearCounters(db, prefix)

    const login = await loginUser(env, { email: EMAIL })
    expect(login.status).toBe(200)
    expect(await login.json()).toMatchObject({ success: true })
    // 存储的启用状态不变，只是登录不再提供该方式。
    expect((await me(env, cookie)).emailTwoFactorEnabled).toBe(true)
  })

  it("TOTP + 邮箱并存：methods 含两者，邮箱验码可登录", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    configureResend(db, prefix)
    stub = stubResend()

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    await enableTotp(env, cookie)
    await enableEmail(env, cookie)
    clearCounters(db, prefix)

    const step = await beginSecondStep(env)
    expect([...step.methods].sort()).toEqual(["email", "totp"])

    const sent = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: step.tempToken
    })
    expect(sent.status).toBe(200)
    const code = codeFromEmail(stub.sent.at(-1))
    const verified = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: step.tempToken,
      method: "email",
      code
    })
    expect(verified.status).toBe(200)
  })

  it("找回密码的码不能当邮箱第二因子用", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    configureResend(db, prefix)
    stub = stubResend()

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    await enableEmail(env, cookie)
    clearCounters(db, prefix)
    const step = await beginSecondStep(env)
    const { code } = await issueVerificationCode(env, {
      email: EMAIL,
      purpose: "password_reset"
    })

    const res = await postJson(env, "/api/auth/2fa/verify", {
      tempToken: step.tempToken,
      method: "email",
      code
    })
    expect(res.status).toBe(400)
    const resBody = (await res.json()) as { code: string }
    expect(resBody.code).toBe("INVALID_CODE")
  })

  it("启用发码失败回 502 EMAIL_SEND_FAILED", async () => {
    const { env, db } = await initializedContext()
    configureResend(db, activePrefix(env))
    stub = stubResend({ fail: { status: 500, body: "provider down" } })

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    const setup = await postJson(
      env,
      "/api/auth/2fa/email/setup",
      {},
      { cookie }
    )
    expect(setup.status).toBe(502)
    const setupBody = (await setup.json()) as { code: string }
    expect(setupBody.code).toBe("EMAIL_SEND_FAILED")
  })

  it("登录发码失败回 502 EMAIL_SEND_FAILED，且不回显 provider 原文", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    configureResend(db, prefix)
    stub = stubResend()

    const { cookie } = await registerAndLogin(env, { email: EMAIL })
    const userId = (await me(env, cookie)).id
    await setEmailTwoFactorEnabled(env.DB, prefix, userId, true)
    clearCounters(db, prefix)
    stub.restore()
    stub = stubResend({ fail: { status: 500, body: "provider down" } })

    const step = await beginSecondStep(env)
    const sent = await postJson(env, "/api/auth/2fa/email/send", {
      tempToken: step.tempToken
    })
    expect(sent.status).toBe(502)
    const body = (await sent.json()) as { code: string; detail?: string }
    expect(body.code).toBe("EMAIL_SEND_FAILED")
    expect(body.detail).toBeUndefined()
  })
})
