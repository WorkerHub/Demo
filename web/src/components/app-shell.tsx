import {
  InfoIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserIcon
} from "lucide-react"
import { useCallback, useRef, useState } from "react"
import type * as React from "react"
import { useTranslation } from "react-i18next"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router"
import { LanguageCycleButton } from "@/components/language-toggle"
import { ThemeCycleButton } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger
} from "@/components/ui/sidebar"
import { UserAvatar } from "@/components/user-avatar"
import { buildVersionLabel } from "@/lib/build-info"
import { titleKeyFor } from "@/hooks/use-page-title"
import { accountPrimaryLabel } from "@/lib/user-identity"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"

const SIDEBAR_ITEMS = [
  {
    to: "/workbench",
    labelKey: "workbench.nav.workbench",
    icon: LayoutDashboardIcon
  }
] as const

/** 头像下拉里的页面入口；系统管理仍只对管理员显示。 */
const ACCOUNT_ITEMS = [
  { to: "/profile", labelKey: "profile.title", icon: UserIcon },
  {
    to: "/admin",
    labelKey: "workbench.nav.admin",
    icon: ShieldCheckIcon,
    adminOnly: true
  },
  { to: "/settings", labelKey: "workbench.nav.settings", icon: SettingsIcon },
  { to: "/about", labelKey: "workbench.nav.about", icon: InfoIcon }
] as const

/** 侧栏宽度：只存本机 localStorage，不进用户属性（同主题口径）。 */
const SIDEBAR_WIDTH_STORAGE_KEY = "app-sidebar-width"
const SIDEBAR_OPEN_STORAGE_KEY = "app-sidebar-open"
const SIDEBAR_WIDTH_DEFAULT = 240
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 360
/** 位移超过该值才算拖动，否则视为点击收起/展开。 */
const SIDEBAR_DRAG_THRESHOLD = 3

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(value))
  )
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_WIDTH_DEFAULT
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT
    return clampWidth(Number(raw))
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

function readStoredOpen(): boolean {
  if (typeof window === "undefined") return true
  try {
    const raw = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)
    return raw === null ? true : raw !== "false"
  } catch {
    return true
  }
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()

  return (
    <nav className="flex flex-col gap-1 p-2">
      {SIDEBAR_ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              isActive
                ? "flex items-center gap-2 rounded-lg bg-sidebar-accent px-2.5 py-1.5 text-sm font-medium text-sidebar-accent-foreground"
                : "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {t(item.labelKey)}
          </NavLink>
        )
      })}
    </nav>
  )
}

/**
 * 登录后的应用壳：侧边栏 + 顶栏 + 内容区（技术方案 §3C 的三件套骨架）。
 *
 * 侧栏用 shadcn 官方 Sidebar（collapsible="icon"）：右缘可拖宽、底部收起/展开、
 * 收起后为图标栏（悬停出名称）。宽度与展开状态只存 localStorage。移动端沿用
 * 顶栏汉堡打开的原 Sheet 抽屉，侧栏与账号菜单（个人资料 / 系统管理 / 设置 /
 * 关于）的信息架构不变。
 */
export function AppShell() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const role = useAuthStore((state) => state.user?.role)
  const name = useSiteStore((state) => state.info?.name ?? "")
  const [mobileOpen, setMobileOpen] = useState(false)

  const [open, setOpen] = useState(readStoredOpen)
  const [width, setWidth] = useState(readStoredWidth)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{
    startX: number
    startWidth: number
    dragged: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)

  const titleKey = titleKeyFor(location.pathname)
  const primaryLabel = accountPrimaryLabel(user)

  const persistOpen = useCallback((next: boolean) => {
    setOpen(next)
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next))
    } catch {
      // localStorage 被禁用时不阻塞交互。
    }
  }, [])

  const persistWidth = useCallback((next: number) => {
    setWidth(next)
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next))
    } catch {
      // localStorage 被禁用时不阻塞交互。
    }
  }, [])

  const onRailPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressClickRef.current = false
      // 收起态右缘只做点击展开，不拖宽。
      if (!open) return
      dragRef.current = {
        startX: event.clientX,
        startWidth: width,
        dragged: false
      }

      // 用 window 级监听收指针移动：右缘只有 16px 宽，指针一旦移出按钮，
      // 元素级 onPointerMove 就收不到了（headless Chrome 下 setPointerCapture
      // 实测也不可靠）。
      const onMove = (e: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = e.clientX - drag.startX
        if (Math.abs(dx) > SIDEBAR_DRAG_THRESHOLD) {
          drag.dragged = true
          setResizing(true)
        }
        if (drag.dragged) {
          setWidth(clampWidth(drag.startWidth + dx))
        }
      }
      const onEnd = (e: PointerEvent) => {
        const drag = dragRef.current
        dragRef.current = null
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onEnd)
        window.removeEventListener("pointercancel", onEnd)
        if (drag?.dragged) {
          persistWidth(clampWidth(drag.startWidth + e.clientX - drag.startX))
          // 拖动松手后的 click 不再触发收起/展开。
          suppressClickRef.current = true
        }
        setResizing(false)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onEnd)
      window.addEventListener("pointercancel", onEnd)
    },
    [open, width, persistWidth]
  )

  const onRailClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    persistOpen(!open)
  }, [persistOpen, open])

  const signOut = async () => {
    await logout()
    navigate("/login", { replace: true })
  }

  return (
    <SidebarProvider
      open={open}
      onOpenChange={persistOpen}
      data-resizing={resizing ? "" : undefined}
      style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}
      className="min-h-svh bg-background text-foreground"
    >
      <Sidebar collapsible="icon">
        <SidebarHeader className="p-0">
          <NavLink
            to="/workbench"
            aria-label={name || undefined}
            title={name}
            className="flex h-14 items-center px-3 font-heading text-sm font-semibold tracking-tight transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <span className="truncate group-data-[collapsible=icon]:hidden">
              {name}
            </span>
            <span
              aria-hidden="true"
              className="hidden size-4 shrink-0 text-center text-base leading-4 group-data-[collapsible=icon]:inline-block"
            >
              {name.slice(0, 1)}
            </span>
          </NavLink>
        </SidebarHeader>
        <SidebarContent>
          <nav>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {SIDEBAR_ITEMS.map((item) => {
                    const Icon = item.icon
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          asChild
                          isActive={location.pathname === item.to}
                          tooltip={t(item.labelKey)}
                        >
                          <NavLink to={item.to}>
                            <Icon aria-hidden="true" />
                            <span>{t(item.labelKey)}</span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
        </SidebarContent>
        <SidebarFooter className="gap-1">
          <div className="truncate px-2 text-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
            {buildVersionLabel(name || undefined)}
          </div>
          <SidebarTrigger
            aria-label={t(open ? "sidebar.collapse" : "sidebar.expand")}
            title={t(open ? "sidebar.collapse" : "sidebar.expand")}
          />
        </SidebarFooter>
        <SidebarRail
          aria-label={t("sidebar.resize")}
          title={t("sidebar.resize")}
          onPointerDown={onRailPointerDown}
          onClick={onRailClick}
        />
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label={t("workbench.menu")}
              >
                <MenuIcon aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-0">
              <SheetHeader className="border-b px-4 py-3">
                <SheetTitle className="text-sm font-semibold">
                  <NavLink to="/workbench" onClick={() => setMobileOpen(false)}>
                    {name}
                  </NavLink>
                </SheetTitle>
              </SheetHeader>
              <Navigation onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>

          <h1 className="truncate font-heading text-sm font-medium">
            {t(titleKey)}
          </h1>

          <div className="ml-auto flex items-center gap-1">
            <LanguageCycleButton />
            <ThemeCycleButton />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className="rounded-full"
                  aria-label={t("workbench.account")}
                >
                  <UserAvatar user={user} className="size-7" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex items-center gap-2">
                  <UserAvatar user={user} className="size-9" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {primaryLabel}
                    </span>
                    {primaryLabel === user?.email ? null : (
                      <span className="truncate text-xs font-normal">
                        {user?.email}
                      </span>
                    )}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {ACCOUNT_ITEMS.filter(
                  (item) => !("adminOnly" in item) || role === "admin"
                ).map((item) => {
                  const Icon = item.icon
                  return (
                    <DropdownMenuItem
                      key={item.to}
                      onSelect={() => navigate(item.to)}
                    >
                      <Icon aria-hidden="true" />
                      {t(item.labelKey)}
                    </DropdownMenuItem>
                  )
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut()}>
                  <LogOutIcon aria-hidden="true" />
                  {t("workbench.logout")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </SidebarProvider>
  )
}
