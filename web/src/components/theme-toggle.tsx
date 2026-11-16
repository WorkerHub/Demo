import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { isTheme, THEME_OPTIONS, type Theme } from "@/lib/theme"
import { useThemeStore } from "@/stores/theme"

const THEME_ICONS = {
  auto: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon
} as const

/** 设置页里的三档分段控件：只改本机偏好（localStorage）。 */
export function ThemeSegmented() {
  const { t } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)

  const select = (next: Theme) => {
    if (next === theme) return
    setTheme(next)
  }

  return (
    <ToggleGroup
      type="single"
      value={theme}
      onValueChange={(value) => {
        if (isTheme(value)) select(value)
      }}
      aria-label={t("settings.preferences.theme.label")}
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = THEME_ICONS[option.value]
        return (
          <ToggleGroupItem key={option.value} value={option.value} size="sm">
            <Icon aria-hidden="true" />
            {t(option.labelKey)}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

/** 顶栏与未登录页的主题循环按钮：自动 → 亮 → 暗 → 自动，只改本机偏好。 */
export function ThemeCycleButton() {
  const { t } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const next: Theme =
    theme === "auto" ? "light" : theme === "light" ? "dark" : "auto"
  const Icon = THEME_ICONS[theme]
  const label = t("common.theme.switch", {
    theme: t(`common.theme.${theme}`)
  })

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={() => setTheme(next)}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
