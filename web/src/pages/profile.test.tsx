import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { me } from "@/test/fixtures"
import { ProfilePage } from "@/pages/profile"
import { useAuthStore } from "@/stores/auth"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      update: vi.fn()
    }
  }
})

const { ApiError, meApi } = await import("@/lib/api")

beforeEach(() => {
  useAuthStore.setState({ user: me(), status: "ready" })
  vi.mocked(meApi.update).mockResolvedValue(me())
})

describe("个人资料页", () => {
  it("改用户名后提交 displayName 与 username 并回填", async () => {
    vi.mocked(meApi.update).mockResolvedValue(me({ username: "水手" }))
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.type(screen.getByLabelText("用户名"), "水手")
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(meApi.update).toHaveBeenCalledWith({
        displayName: "Owner",
        username: "水手"
      })
    )
    expect(screen.getByLabelText("用户名")).toHaveValue("水手")
  })

  it("未改用户名时请求体不带 username", async () => {
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(meApi.update).toHaveBeenCalledWith({ displayName: "Owner" })
    )
  })

  it("用户名被占用时显示对应错误文案", async () => {
    vi.mocked(meApi.update).mockRejectedValue(
      new ApiError({
        status: 409,
        code: "USERNAME_TAKEN",
        message: "Username taken"
      })
    )
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.type(screen.getByLabelText("用户名"), "水手")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "该用户名已被占用"
    )
    expect(screen.getByLabelText("用户名")).toHaveValue("水手")
  })
})
