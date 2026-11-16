import { describe, expect, it } from "vitest"
import { accountInitial, accountPrimaryLabel } from "@/lib/user-identity"

const base = { email: "owner@example.com", displayName: "Owner", username: "" }

describe("账号身份", () => {
  it("用户名优先于显示名称与邮箱", () => {
    expect(accountPrimaryLabel({ ...base, username: "水手" })).toBe("水手")
    expect(accountInitial({ ...base, username: "水手" })).toBe("水")
  })

  it("未设置用户名时回落到显示名称", () => {
    expect(accountPrimaryLabel(base)).toBe("Owner")
    expect(accountInitial(base)).toBe("O")
  })

  it("显示名称也为空时回落到邮箱", () => {
    const user = { ...base, displayName: "" }
    expect(accountPrimaryLabel(user)).toBe("owner@example.com")
    expect(accountInitial(user)).toBe("O")
  })

  it("全空与空用户返回空串", () => {
    expect(accountPrimaryLabel(null)).toBe("")
    expect(accountInitial({ ...base, displayName: "", email: "" })).toBe("")
  })

  it("按码点取首字，代理对不被截断", () => {
    expect(accountInitial({ ...base, username: "🙂船" })).toBe("🙂")
  })

  it("首字母转大写", () => {
    expect(accountInitial({ ...base, username: "sailor" })).toBe("S")
  })
})
