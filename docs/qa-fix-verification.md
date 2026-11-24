# 修复单复验协议

验收「某个修复是否生效」的协议，避免基线失真与假绿。适用于 wrangler dev 型 worker + SPA 的同栈项目。

## 差分复验（前后对照）

- 同一支脚本分别跑「修复前 commit」与「修复后 commit」两个本地实例（端口各占一个），逐条比对断言。
- 修复前必须复现原缺陷的精确数字/行为——复现不出来说明口径没有检出能力，不能据此宣布修复生效；修复后全绿才算通过。
- 「修复前」基线必须用修复提交的父提交，不能用远古提交（可能差几百个文件，跳转/渲染类结论完全失真）。
- 脚本逐断言 `try/catch` 记 FAIL 不中断；两个实例绝不共用端口。

## 本地真跑实例起法

1. `git worktree add --detach /tmp/<name> <commit>`：pnpm 拒绝符号链接 node_modules（`ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`），git archive 快照 + 软链跑不了 build，必须真 worktree；clone 目录只读且 prebuild 会写 `build-info.json`，勿在 clone 内构建。
2. `pnpm install --frozen-lockfile` → 根构建脚本（如 `pnpm build:web`，由根 prebuild 生成 `build-info.json`；直接 `pnpm --filter web build` 会报缺 build-info 的 TS2307）。
3. `worker/.dev.vars`：`ENCRYPTION_KEY` 用合法 32 字节 base64（`openssl rand -base64 32`；写错则接口全返 Server misconfigured）+ `SETUP_SECRET`，按需加 `TABLE_PREFIX`、`APP_VERSION=v<semver>-<n>-<sha>`（本地版本自证口只认 env，缺省显示 v1.0.0-0-unknown 属正常）。
4. 空闲端口 `wrangler dev`（`--persist-to` 独立目录）。worker 托管 `web/dist` 自带 SPA 回退：直接访问 worker 端口即可测整页刷新，无需 vite dev。
5. 初始化：`POST /api/setup`（带 `X-Setup-Secret` 头）；首个注册用户即管理员。
6. 结束 `git worktree remove --force`。

- 运行中绝不能删 `worker/.wrangler`（bundle 缓存被删 → 实例报 middleware-loader 解析失败）；换实例先杀 workerd 再删。
- `wrangler d1 execute --local` 可用占位库名直接操作本地 D1（先看仓库的表前缀/库名约定）；dev server 在跑时别对同一 sqlite 并发写。

## 生产字节 + 本地 API 组合

生产账号不可用时，可以「生产前端字节 + 本地 API」实测：

1. `git merge-base --is-ancestor <fix> <prodHEAD>` 证明修复 commit 在生产版本内。
2. 下载生产 `index.html` 及全部 assets（curl 需带浏览器 UA，否则网关 403），本地直服并把 `/api/` 反代到本地 wrangler dev。
3. 对本地构建产物做逐文件 sha256 + 哈希文件名归一化比对，证明与生产一致（build-info 的 builtAt/timeZone、CDN 注入的 challenge 脚本除外）。

## 前置检查

- 工作区可能被前会话污染：本地构建产物覆盖源文件（`git status` 出现 M）、遗留 wrangler dev 进程。回归前先 `git status`，必要时干净克隆重跑。
- node_modules 经 rsync / `cp -r` / 整目录搬移会坏（pnpm 软链悬空）：tsc 报 TS7006、vite/rolldown 报 tunnel-rat 无法解析 react 这类假错误。修复：`rm -rf` 各层 node_modules 后 `pnpm install --frozen-lockfile`（store 热，几秒）。

## 登录态与会话注入

- 登录接口常有限流（IP 级每分钟窗口、同账号连击更快触发 429）：批量场景别打登录接口，直接往 context 注入会话 cookie。Playwright 写法：`context.addCookies([{ name, value, domain: "127.0.0.1", path: "/", secure: false }])`（domain+path 写空串会报错；也可用 `{ name, value, url: BASE }`），再用 /api/me 之类的自证接口校验注入成功。
- Playwright context 用 `newContext({ serviceWorkers: "block" })`：生产 sw.js 若被直通注册，请求会从 SW 发出、绕开 `page.route`。
