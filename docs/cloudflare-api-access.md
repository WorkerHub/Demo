# 用本机 wrangler OAuth 直调 Cloudflare API

QA 需要核实生产 D1/R2 状态时，本机 wrangler 的 OAuth 凭证可直接调 Cloudflare API（免 wrangler 的只读查询、对象级 R2 操作）。以下为方法与红线；不涉及任何具体账号/库/桶标识。

## 凭证

- token 在 `~/.wrangler/config/default.toml` 的 `oauth_token` 字段（awk 提取）。不落盘、不回显、不写进任何文档/报告/提交。
- scope 含 `d1:write`、`workers` 等——能写生产。默认只做只读操作；任何写操作（含 R2 PUT/DELETE）必须任务明确授权。
- token 过期（401）后随便跑一个 wrangler 命令（如 `wrangler whoami`）会自动刷新，重新提取即可。
- 账号 id / D1 库 id / 桶名：用 `wrangler whoami`、`wrangler d1 list`、`wrangler r2 bucket list` 现查，不存记忆。

## D1 查询

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DB_ID/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sql":"select count(*) as n from <table> where email like ?","params":["%@test"]}'
```

- 值用 `params` 传，防注入；不要把值拼进 `sql` 字符串。
- 表前缀/库名按各项目仓库约定（有的用 `TABLE_PREFIX`/占位库名，有的无前缀）。

## R2 对象

- 对象级 SAPI：`GET/DELETE /accounts/{a}/r2/buckets/{bucket}/objects/{key}`，上传 `PUT` 同路径；也可用 `wrangler r2 object get/put/delete --remote`（QA 实测可读写），本地链路用 `--local`。
- LIST：`/accounts/{a}/r2/buckets/{bucket}/objects?per_page=1000`（单页上限 1000），翻页用响应里 `result_info.pagination.cursor`。
- 生产 R2 读回的 ETag 是弱 ETag `W/"…"`（R2 SaaS 行为），与本地 miniflare 的强 ETag 格式不同——是环境差异，不是缺陷。
- QA 清理纪律：上传前后对桶做全量快照逐 key 比对；删除只用按 key 精确 `DELETE`，严禁批量删除。

## 版本自证口

- 部署是否到位：`GET /api/public` 的 `version` 字段（本地 dev 只认 env `APP_VERSION`，缺省显示 v1.0.0-0-unknown 属正常）；部分栈另有 `GET /api/setup/state`。
- 部署流水线通常在部署后自证版本（日志里形如 `Version self-verification passed: serving vX.Y.Z-N-<sha>`），用 workflow_runs 读 deploy job 日志即可拿到权威结论。
