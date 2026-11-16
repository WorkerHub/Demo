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
  it("默认只读展示昵称与用户名，编辑按钮可用", () => {
    useAuthStore.setState({
      user: me({ displayName: "Owner", username: "水手" }),
      status: "ready"
    })
    render(<ProfilePage />)

    expect(screen.getByText("Owner")).toBeInTheDocument()
    expect(screen.getByText("水手")).toBeInTheDocument()
    expect(screen.queryByLabelText("昵称")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "编辑" })).toBeEnabled()
  })

  it("点「编辑」后出现输入框并回填当前值", async () => {
    useAuthStore.setState({
      user: me({ displayName: "Owner", username: "水手" }),
      status: "ready"
    })
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.click(screen.getByRole("button", { name: "编辑" }))

    expect(screen.getByLabelText("昵称")).toHaveValue("Owner")
    expect(screen.getByLabelText("用户名")).toHaveValue("水手")
  })

  it("改用户名后提交 displayName 与 username 并回到只读展示", async () => {
    vi.mocked(meApi.update).mockResolvedValue(me({ username: "水手" }))
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.click(screen.getByRole("button", { name: "编辑" }))
    await user.type(screen.getByLabelText("用户名"), "水手")
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(meApi.update).toHaveBeenCalledWith({
        displayName: "Owner",
        username: "水手"
      })
    )
    expect(await screen.findByText("水手")).toBeInTheDocument()
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument()
  })

  it("未改用户名时请求体不带 username", async () => {
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.click(screen.getByRole("button", { name: "编辑" }))
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

    await user.click(screen.getByRole("button", { name: "编辑" }))
    await user.type(screen.getByLabelText("用户名"), "水手")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "该用户名已被占用"
    )
    expect(screen.getByLabelText("用户名")).toHaveValue("水手")
  })

  it("锁定昵称时编辑按钮置灰", () => {
    useAuthStore.setState({
      user: me({
        profileLocks: { displayNameLocked: true, usernameLocked: false }
      }),
      status: "ready"
    })
    render(<ProfilePage />)

    expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled()
  })

  it("仅锁定用户名时编辑按钮同样置灰", () => {
    useAuthStore.setState({
      user: me({
        profileLocks: { displayNameLocked: false, usernameLocked: true }
      }),
      status: "ready"
    })
    render(<ProfilePage />)

    expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled()
  })

  it("点「取消」回到只读且不调更新接口", async () => {
    const user = userEvent.setup()
    render(<ProfilePage />)

    await user.click(screen.getByRole("button", { name: "编辑" }))
    await user.type(screen.getByLabelText("用户名"), "水手")
    await user.click(screen.getByRole("button", { name: "取消" }))

    expect(meApi.update).not.toHaveBeenCalled()
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument()
  })
})
