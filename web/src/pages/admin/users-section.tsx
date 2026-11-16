import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { currentLanguage } from "@/i18n"
import { adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { AdminUser } from "@/lib/api-types"
import { intlLocale } from "@/lib/language"
import { useAuthStore } from "@/stores/auth"

const ROLE_VARIANT = { admin: "secondary", user: "outline" } as const
const STATUS_VARIANT = {
  active: "secondary",
  pending: "default",
  disabled: "outline"
} as const

/** 系统管理 · 全部用户（只读列表；待批准行内可批准/拒绝）。 */
export function UsersSection() {
  const { t } = useTranslation()
  const selfId = useAuthStore((state) => state.user?.id)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const result = await adminApi.users()
      setUsers(result.items)
    } catch (loadError) {
      setError(describeApiError(t, loadError))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (user: AdminUser, action: "approve" | "reject") => {
    setBusyId(user.id)
    setError("")
    try {
      if (action === "approve") await adminApi.approveUser(user.id)
      else await adminApi.rejectUser(user.id)
      toast.success(
        t(
          action === "approve" ? "admin.users.approved" : "admin.users.rejected"
        )
      )
      await load()
    } catch (actionError) {
      setError(describeApiError(t, actionError))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h3 className="font-heading text-sm font-semibold">
        {t("admin.users.title")}
      </h3>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("admin.users.empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.email")}</TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("admin.users.displayName")}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t("admin.users.role")}
              </TableHead>
              <TableHead>{t("admin.users.status")}</TableHead>
              <TableHead className="text-right">
                {t("admin.users.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="max-w-48">
                  <div className="flex flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{user.email}</span>
                      {user.id === selfId ? (
                        <Badge variant="outline">{t("admin.users.self")}</Badge>
                      ) : null}
                      {user.emailVerified ? null : (
                        <Badge variant="outline">
                          {t("admin.users.emailUnverified")}
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("admin.users.createdAt", {
                        date: new Date(user.createdAt).toLocaleString(
                          intlLocale(currentLanguage())
                        )
                      })}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <div className="flex flex-col">
                    <span>{user.displayName || "—"}</span>
                    {user.username ? (
                      <span className="text-xs text-muted-foreground">
                        @{user.username}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <Badge variant={ROLE_VARIANT[user.role]}>
                    {t(`common.role.${user.role}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[user.status]}>
                    {t(`common.status.${user.status}`)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {user.status === "pending" ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busyId === user.id}
                        onClick={() => void act(user, "approve")}
                      >
                        {t("admin.users.approve")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busyId === user.id}
                        onClick={() => void act(user, "reject")}
                      >
                        {t("admin.users.reject")}
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
