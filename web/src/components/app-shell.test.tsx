import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it } from "vitest"
import { AppShell } from "@/components/app-shell"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"
import { me, publicInfo } from "@/test/fixtures"

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: "/workbench",
        element: <AppShell />,
        children: [{ index: true, element: <div>content</div> }]
      }
    ],
    { initialEntries: ["/workbench"] }
  )
  return render(<RouterProvider router={router} />)
}

function sidebarRoot(): HTMLElement {
  const el = document.querySelector<HTMLElement>("div[data-slot='sidebar']")
  if (!el) throw new Error("desktop sidebar root not found")
  return el
}

function sidebarWidth(): string {
  const el = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")
  if (!el) throw new Error("sidebar wrapper not found")
  return el.style.getPropertyValue("--sidebar-width")
}

function rail(): HTMLElement {
  const el = screen.getByRole("button", { name: "调整侧栏宽度" })
  return el
}

beforeEach(() => {
  useAuthStore.setState({ user: me(), status: "ready" })
  useSiteStore.setState({ info: publicInfo(), loaded: true })
})

describe("应用壳侧栏", () => {
  it("桌面侧栏含站名链接与工作台入口", () => {
    renderShell()

    expect(screen.getByRole("link", { name: "Template" })).toHaveAttribute(
      "href",
      "/workbench"
    )
    const nav = screen.getByRole("navigation")
    expect(
      within(nav).getAllByRole("link").map((link) => link.textContent)
    ).toEqual(["工作台"])
  })

  it("底部按钮收起→展开，只写 localStorage、不写 cookie", async () => {
    const user = userEvent.setup()
    renderShell()

    expect(sidebarRoot().getAttribute("data-state")).toBe("expanded")

    await user.click(screen.getByRole("button", { name: "收起侧栏" }))
    expect(sidebarRoot().getAttribute("data-state")).toBe("collapsed")
    expect(localStorage.getItem("app-sidebar-open")).toBe("false")
    expect(document.cookie).toBe("")

    await user.click(screen.getByRole("button", { name: "展开侧栏" }))
    expect(sidebarRoot().getAttribute("data-state")).toBe("expanded")
    expect(localStorage.getItem("app-sidebar-open")).toBe("true")
  })

  it("预置收起状态后首屏即收起", () => {
    localStorage.setItem("app-sidebar-open", "false")
    renderShell()

    expect(sidebarRoot().getAttribute("data-state")).toBe("collapsed")
  })

  it("拖动右缘改宽度并夹紧到 360，松手点击不误触收起", () => {
    renderShell()
    const el = rail()

    fireEvent.pointerDown(el, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 700, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 700, pointerId: 1 })

    expect(localStorage.getItem("app-sidebar-width")).toBe("360")
    expect(sidebarWidth()).toBe("360px")

    // 拖动结束后的 click 被吞掉，不收起。
    fireEvent.click(el)
    expect(sidebarRoot().getAttribute("data-state")).toBe("expanded")
  })

  it("拖动到下限夹紧到 200", () => {
    renderShell()
    const el = rail()

    fireEvent.pointerDown(el, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 80, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 80, pointerId: 1 })

    expect(localStorage.getItem("app-sidebar-width")).toBe("200")
  })

  it("脏宽度值回落默认 240", () => {
    localStorage.setItem("app-sidebar-width", "oops")
    renderShell()

    expect(sidebarWidth()).toBe("240px")
  })

  it("越界宽度值被夹紧", () => {
    localStorage.setItem("app-sidebar-width", "9999")
    renderShell()

    expect(sidebarWidth()).toBe("360px")
  })
})

