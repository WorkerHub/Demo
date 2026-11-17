import {
  InfoIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserIcon
} from "lucide-react"
import { useState } from "react"
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
 * 侧栏只留工作台；个人资料 / 系统管理 / 设置 / 关于在顶栏头像菜单里
 * （系统管理按角色隐藏，接口层另有 403）。移动端把同一份侧栏装进 Sheet。
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

  const titleKey = titleKeyFor(location.pathname)
  const primaryLabel = accountPrimaryLabel(user)

  const signOut = async () => {
    await logout()
    navigate("/login", { replace: true })
  }

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <NavLink
          to="/workbench"
          className="flex h-14 items-center px-4 font-heading text-sm font-semibold tracking-tight transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {name}
        </NavLink>
        <Navigation />
        <div className="mt-auto border-t border-sidebar-border px-4 py-3 text-xs text-sidebar-foreground/60">
          {buildVersionLabel(name || undefined)}
        </div>
      </aside>

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
    </div>
  )
}
