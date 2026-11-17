import { CopyIcon, EllipsisIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { currentLanguage, i18n } from "@/i18n"
import { type AdminResetPasswordResult, ApiError, adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { AdminUser, UserRole } from "@/lib/api-types"
import { intlLocale } from "@/lib/language"
import { useAuthStore } from "@/stores/auth"

const ROLE_VARIANT = { admin: "secondary", user: "outline" } as const
const STATUS_VARIANT = {
  active: "secondary",
  pending: "default",
  disabled: "outline"
} as const

/**
 * 系统管理 · 全部用户：待批准行内审核，其余行「⋯」四操作
 * （重置密码 / 停用·启用 / 变更角色 / 删除）。
 *
 * 护栏：对自己的行不显示删除与停用；最后管理员由服务端 409 报错，前端只按
 * 错误码回显，不预判、不假装成功。重置密码的一次性口令只进组件 state，
 * 关闭弹窗即丢——不写本地存储、不进提示语与 URL。
 */
export function UsersSection() {
  const { t } = useTranslation()
  const selfId = useAuthStore((state) => state.user?.id)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [roleTarget, setRoleTarget] = useState<AdminUser | null>(null)
  const [roleDraft, setRoleDraft] = useState<UserRole>("user")
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)
  const [resetResult, setResetResult] =
    useState<AdminResetPasswordResult | null>(null)
  const [dialogError, setDialogError] = useState("")
  const [dialogBusy, setDialogBusy] = useState(false)

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

  /** 已知的四类操作错误码用本单文案；其它错误回落统一映射。 */
  const actionErrorText = (actionError: unknown) => {
    if (actionError instanceof ApiError && actionError.code) {
      const key = `admin.users.errors.${actionError.code}`
      if (i18n.exists(key)) return t(key)
    }
    return describeApiError(t, actionError)
  }

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

  const runResetPassword = async (user: AdminUser) => {
    setBusyId(user.id)
    setError("")
    try {
      setResetResult(await adminApi.resetUserPassword(user.id))
    } catch (actionError) {
      setError(actionErrorText(actionError))
    } finally {
      setBusyId(null)
    }
  }

  const runStatusToggle = async (user: AdminUser) => {
    setBusyId(user.id)
    setError("")
    try {
      if (user.status === "disabled") {
        await adminApi.enableUser(user.id)
        toast.success(t("admin.users.enabledToast"))
      } else {
        await adminApi.disableUser(user.id)
        toast.success(t("admin.users.disabledToast"))
      }
      await load()
    } catch (actionError) {
      setError(actionErrorText(actionError))
    } finally {
      setBusyId(null)
    }
  }

  const copyTemporaryPassword = async () => {
    if (!resetResult) return
    try {
      await navigator.clipboard.writeText(resetResult.temporaryPassword)
      toast.success(t("admin.users.create.copied"))
    } catch {
      toast.error(t("admin.users.create.copyFailed"))
    }
  }

  const openRoleDialog = (user: AdminUser) => {
    setRoleTarget(user)
    setRoleDraft(user.role)
    setDialogError("")
  }

  const submitRole = async () => {
    if (!roleTarget) return
    setDialogBusy(true)
    setDialogError("")
    try {
      await adminApi.changeUserRole(roleTarget.id, roleDraft)
      toast.success(t("admin.users.roleChanged"))
      setRoleTarget(null)
      await load()
    } catch (actionError) {
      setDialogError(actionErrorText(actionError))
    } finally {
      setDialogBusy(false)
    }
  }

  const openDeleteDialog = (user: AdminUser) => {
    setDeleteTarget(user)
    setDialogError("")
  }

  const submitDelete = async () => {
    if (!deleteTarget) return
    setDialogBusy(true)
    setDialogError("")
    try {
      await adminApi.deleteUser(deleteTarget.id)
      toast.success(t("admin.users.deleted"))
      setDeleteTarget(null)
      await load()
    } catch (actionError) {
      setDialogError(actionErrorText(actionError))
    } finally {
      setDialogBusy(false)
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
              <TableHead className="hidden sm:table-cell">
                {t("admin.users.status")}
              </TableHead>
              <TableHead className="text-right">
                {t("admin.users.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="w-full max-w-0">
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
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge
                        variant={STATUS_VARIANT[user.status]}
                        className="sm:hidden"
                      >
                        {t(`common.status.${user.status}`)}
                      </Badge>
                      <span className="truncate">
                        {t("admin.users.createdAt", {
                          date: new Date(user.createdAt).toLocaleString(
                            intlLocale(currentLanguage())
                          )
                        })}
                      </span>
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span>{user.displayName || "—"}</span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <Badge variant={ROLE_VARIANT[user.role]}>
                    {t(`common.role.${user.role}`)}
                  </Badge>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
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
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="ml-auto"
                          disabled={busyId === user.id}
                          aria-label={t("admin.users.rowMenu", {
                            email: user.email
                          })}
                        >
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          onSelect={() => void runResetPassword(user)}
                        >
                          {t("admin.users.resetPassword")}
                        </DropdownMenuItem>
                        {user.id === selfId ? null : (
                          <DropdownMenuItem
                            onSelect={() => void runStatusToggle(user)}
                          >
                            {user.status === "disabled"
                              ? t("admin.users.enable")
                              : t("admin.users.disable")}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => openRoleDialog(user)}>
                          {t("admin.users.changeRole")}
                        </DropdownMenuItem>
                        {user.id === selfId ? null : (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => openDeleteDialog(user)}
                            >
                              {t("admin.users.delete")}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRoleTarget(null)
            setDialogError("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.users.changeRole")}</DialogTitle>
            <DialogDescription>{roleTarget?.email}</DialogDescription>
          </DialogHeader>
          <ToggleGroup
            type="single"
            value={roleDraft}
            aria-label={t("admin.users.changeRole")}
            onValueChange={(value) => {
              // Radix 再点当前项会回传空串：忽略它，角色恒有值。
              if (value === "admin" || value === "user") setRoleDraft(value)
            }}
          >
            <ToggleGroupItem value="admin" size="sm">
              {t("common.role.admin")}
            </ToggleGroupItem>
            <ToggleGroupItem value="user" size="sm">
              {t("common.role.user")}
            </ToggleGroupItem>
          </ToggleGroup>
          {dialogError ? (
            <p role="alert" className="text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                {t("common.actions.cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              disabled={dialogBusy || roleTarget?.role === roleDraft}
              onClick={() => void submitRole()}
            >
              {t("common.actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetResult !== null}
        onOpenChange={(open) => {
          if (!open) setResetResult(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.users.resetDoneTitle")}</DialogTitle>
            <DialogDescription>{resetResult?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {t("admin.users.temporaryPassword")}
            </p>
            <p className="font-mono break-all select-all">
              {resetResult?.temporaryPassword}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("admin.users.create.passwordOnce")}
          </p>
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyTemporaryPassword()}
            >
              <CopyIcon aria-hidden="true" />
              {t("admin.users.create.copy")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setResetResult(null)}
            >
              {t("common.actions.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDialogError("")
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin.users.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.users.deleteDescription", {
                email: deleteTarget?.email,
                displayName: deleteTarget?.displayName || "—"
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? (
            <p role="alert" className="text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">
              {t("common.actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              disabled={dialogBusy}
              onClick={(event) => {
                // 失败时留在弹窗里；成功才由 submitDelete 关掉。
                event.preventDefault()
                void submitDelete()
              }}
            >
              {t("admin.users.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
