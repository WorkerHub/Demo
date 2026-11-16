import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PencilIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { meApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import { useAuthStore } from "@/stores/auth"

/** 个人资料页：默认只读展示昵称与用户名，点「编辑」才出现输入框；任一资料锁开启时编辑按钮置灰。 */
export function ProfilePage() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState(user?.displayName ?? "")
  const [username, setUsername] = useState(user?.username ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  if (!user) return null

  const locked =
    user.profileLocks.displayNameLocked || user.profileLocks.usernameLocked

  const startEdit = () => {
    setDisplayName(user.displayName)
    setUsername(user.username)
    setError("")
    setEditing(true)
  }

  const cancel = () => {
    setEditing(false)
    setError("")
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    const nextUsername = username.trim()
    try {
      const updated = await meApi.update({
        displayName: displayName.trim(),
        // 未改动（含从未设置时的空串）不发，避免无意义的校验错误。
        ...(nextUsername === (user.username ?? "")
          ? {}
          : { username: nextUsername })
      })
      setUser(updated)
      setDisplayName(updated.displayName)
      // 后端尚未提供 username 时不要清掉刚输入的值。
      if (updated.username !== undefined) setUsername(updated.username)
      toast.success(t("profile.saved"))
      setEditing(false)
    } catch (saveError) {
      setError(describeApiError(t, saveError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {editing ? (
        <form className="space-y-4" onSubmit={save}>
          <div className="space-y-1.5">
            <Label htmlFor="profile-display-name">
              {t("profile.displayName")}
            </Label>
            <Input
              id="profile-display-name"
              name="display-name"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-username">{t("profile.username")}</Label>
            <Input
              id="profile-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? t("common.actions.saving") : t("common.actions.save")}
            </Button>
            <Button type="button" variant="outline" onClick={cancel}>
              {t("common.actions.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <section className="space-y-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={startEdit}
            >
              <PencilIcon />
              {t("common.actions.edit")}
            </Button>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">{t("profile.displayName")}</dt>
            <dd>{user.displayName}</dd>
            <dt className="text-muted-foreground">{t("profile.username")}</dt>
            <dd>{user.username}</dd>
          </dl>
        </section>
      )}

      <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">{t("profile.email")}</dt>
        <dd className="flex items-center gap-2">
          <span className="break-all">{user.email}</span>
          <Badge variant={user.emailVerified ? "secondary" : "outline"}>
            {user.emailVerified
              ? t("profile.emailVerified")
              : t("profile.emailUnverified")}
          </Badge>
        </dd>

        <dt className="text-muted-foreground">{t("profile.role")}</dt>
        <dd>{t(`common.role.${user.role}`)}</dd>
      </dl>
    </div>
  )
}
