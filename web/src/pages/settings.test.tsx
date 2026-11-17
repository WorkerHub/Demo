import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsPage } from "@/pages/settings"
import { useAuthStore } from "@/stores/auth"
import { me } from "@/test/fixtures"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      get: vi.fn(),
      update: vi.fn(),
      changePassword: vi.fn(),
      passkeys: vi.fn(),
      deletePasskey: vi.fn()
    },
    authApi: {
      ...actual.authApi,
      totpSetup: vi.fn(),
      totpEnable: vi.fn(),
      totpDisable: vi.fn()
    }
  }
})

const { meApi } = await import("@/lib/api")

function renderSettings() {
  return render(<SettingsPage />)
}

beforeEach(() => {
  useAuthStore.setState({ user: me(), status: "ready" })
  vi.mocked(meApi.update).mockResolvedValue(me({ language: "en" }))
  vi.mocked(meApi.changePassword).mockResolvedValue({ success: true })
  vi.mocked(meApi.passkeys).mockResolvedValue({ items: [] })
})

describe("设置页", () => {
  it("切换语言即时生效并写回账号", async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(screen.getByRole("tab", { name: "偏好" }))
    await user.click(screen.getByRole("radio", { name: "English" }))

    await waitFor(() =>
      expect(meApi.update).toHaveBeenCalledWith({ language: "en" })
    )
    expect(document.documentElement.lang).toBe("en")
  })

  it("偏好页没有主题控件", async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(screen.getByRole("tab", { name: "偏好" }))

    expect(
      screen.queryByRole("radio", { name: "自动" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("radio", { name: "亮色" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("radio", { name: "暗色" })
    ).not.toBeInTheDocument()
    expect(screen.queryByText("主题")).not.toBeInTheDocument()
  })

  it("时区下拉只列常用时区", async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(screen.getByRole("tab", { name: "偏好" }))
    await user.click(screen.getByRole("combobox", { name: "时区" }))

    const options = await screen.findAllByRole("option")
    const labels = options.map((option) => option.textContent)
    expect(labels).toContain("Asia/Shanghai")
    expect(labels).toContain("America/New_York")
    expect(labels).not.toContain("America/Adak")
    expect(options.length).toBeLessThan(50)
  })

  it("已保存的时区不在常用列表时自动补到最前", async () => {
    useAuthStore.setState({
      user: me({ timezone: "America/Adak" }),
      status: "ready"
    })
    const user = userEvent.setup()
    renderSettings()

    await user.click(screen.getByRole("tab", { name: "偏好" }))
    await user.click(screen.getByRole("combobox", { name: "时区" }))

    const options = await screen.findAllByRole("option")
    expect(options[0].textContent).toBe("America/Adak")
  })

  it("修改密码提交当前密码与新密码", async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(screen.getByRole("tab", { name: "安全" }))
    await user.type(screen.getByLabelText("当前密码"), "old-password")
    await user.type(screen.getByLabelText("新密码"), "brand-new-password")
    await user.type(screen.getByLabelText("确认新密码"), "brand-new-password")
    await user.click(screen.getByRole("button", { name: "更新密码" }))

    await waitFor(() =>
      expect(meApi.changePassword).toHaveBeenCalledWith({
        currentPassword: "old-password",
        newPassword: "brand-new-password"
      })
    )
  })

  it("标签只保留安全与偏好，默认选中安全", () => {
    renderSettings()

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "安全",
      "偏好"
    ])
    expect(screen.getByRole("tab", { name: "安全" })).toHaveAttribute(
      "data-state",
      "active"
    )
  })
})
