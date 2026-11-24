# QA 签收报告 — Todo #34：Passkey 命名 + TOTP 标签 真浏览器验收

**最终裁决：签收（35 PASS / 0 FAIL，无失败项）**

- 被测版本：`v1.0.0-23-539d8f6` = main HEAD `539d8f6`（实现单 #31/#32 已合入并部署生产）
- CI：run `45330729767` success；Deploy：run `45330729819` success
- 全量测试：worker 30 文件/223 用例 + web 19 文件/180 用例，exit=0

## 1. 验收环境与方法

- 本地实例：wrangler dev（工作区同 commit 构建），Playwright 真浏览器 + CDP 虚拟认证器（resident key / UV required），RP ID `http://localhost:8788`
- 主脚本：`/tmp/demo-qa/qa34-main2.mjs`（输出 35 PASS / 0 FAIL）
- 生产只读探针：不改任何生产数据，仅 GET /login、/api/public、bundle 下载 grep
- D1 落库证据：node:sqlite 只读快照

## 2. 逐项签收表

### 2.1 平台项

| # | 标准 | 测法 | 结果 | 证据 |
|---|------|------|------|------|
| P1 | 全量测试绿 | `pnpm --filter ./worker test && pnpm --filter ./web test` | PASS | `/tmp/demo-qa/qa34-pnpm-test.log`（223+180 用例，exit=0） |
| P2 | 主线 CI 绿 | GitHub Actions | PASS | run `45330729767` |
| P3 | 生产部署绿 | Deploy run + `/api/public` | PASS | run `45330729819`；version=`v1.0.0-23-539d8f6` |
| P4 | schema_v7 迁移 | D1 `_demo_schema_migrations` | PASS | schema_v1 + schema_v7 applied |
| P5 | 生产登录页只读探针 | Playwright 打开 /login | PASS | 渲染正常、Passkey 入口 present、版本脚注一致（`shots/34-prod-login-probe.png`） |
| P6 | 生产代码含本次功能 | 下载 bundle grep 功能字符串 | PASS | `index-Mcphk63N.js` 含「添加 Passkey / Passkey 已添加 / 名称已更新 / 修改标签 / totpLabel / 改名」；与本地同 commit 构建仅差 10 字节，CSS 指纹一致 |

### 2.2 TOTP 标签

| # | 标准 | 测法 | 结果 | 证据 |
|---|------|------|------|------|
| A0 | 无 2FA 时密码登录直达 | 密码登录 | PASS | 直达 workbench |
| A1 | 启动返回 otpauth secret | 点开启 | PASS | secret 32 chars |
| A2/A3 | 启用可带标签（trim）+ 行显示标签 | 启用填「`  办公室手机  `」 | PASS | Badge=`办公室手机`（trim 生效）`shots/34-A3-totp-row-with-label.png` |
| A4 | /api/me 暴露标签 | GET /api/me | PASS | `{"totpLabel":"办公室手机","totpEnabled":true}` |
| A5 | 改标签弹窗预填 | 打开修改标签 | PASS | prefill=`"办公室手机"` |
| A6 | 改标签生效 | 改为「个人 iPhone 15」 | PASS | Badge 更新 + toast（`shots/34-A6-totp-label-updated.png`） |
| A7 | 清标签（改空） | 输入纯空格提交 | PASS | Badge 消失 + `totpLabel=null`（`shots/34-A7-totp-label-cleared.png`） |
| D5 | 后端 60 字截断 | PATCH label 60Z+空格 | PASS | 200，回读 len=50 且 trim |
| B1 | 密码登录进 TOTP 第二步 | logout 后再登录 | PASS | `#totp-step` 出现 |
| B2 | 错误码被拒 | 输入 000000 | PASS | 留在第二步（`shots/34-B2-totp-wrong-code.png`） |
| B3 | 正确码通过（验证码校验不回归） | TOTP 真码 | PASS | 进 workbench |
| E1/E2/F2 | 停用清标签（UI+API+D1 三证） | 停用 TOTP | PASS | Badge 消失、`totpLabel=null`、D1 `user_2fa: totp_enabled=0, totp_label=NULL`（`shots/34-E2-totp-disabled-label-cleared.png`） |
| E3 | 未启用改标签被拒 | PATCH label（未启用时） | PASS | 400 `TOTP_NOT_ENABLED` |

### 2.3 Passkey 命名

| # | 标准 | 测法 | 结果 | 证据 |
|---|------|------|------|------|
| C1 | 初始空态 | 打开设置-安全 | PASS | 「尚未添加 Passkey」 |
| C4 | 留空不挡注册 | **第一枚**直接留空名称提交 | PASS | toast「Passkey 已添加」+ rows=1 |
| C5 | 无名称行显示创建日期 | 观察留空行 | PASS | `"添加于 2026/11/24\n\n从未使用\n\n改名\n删除"`（`shots/34-C5-passkey-unnamed-row.png`） |
| C6 | 改名生效 + 有名称行形态 | 改名「办公室钥匙串」 | PASS | `"办公室钥匙串\n\n添加于 2026/11/24 13:44:48\n\n从未使用…"` + toast（`shots/34-C6-passkey-renamed.png`） |
| C7 | 清名（改名为空） | 改名输入空提交 | PASS | 行回纯日期形态 |
| C9 | 名称上限 50 字（前端 maxLength） | 输入 60 个 X | PASS | 输入框截 50，列表行恰 50 个 X |
| D1 | GET /api/me/passkeys 返回 name 字段 | API | PASS | `name: string\|null` |
| D2 | 后端 60 字截断兜底 | PATCH API 60 个 Y | PASS | 200，回读 len=50 |
| D4 | 不存在凭证 | PATCH 不存在 id | PASS | 404 |
| C11/C11b | 密码+Passkey 第二步登录回归 | TOTP 第二步点「用 Passkey 登录」 | PASS | 进 workbench；`lastUsedAt` null→`2026-11-24T05:47:46.810Z` |
| C8 | 删除不回归 | 删除按钮 + 密码确认 | PASS | toast「Passkey 已删除」+ 回空态（`shots/34-C8-passkey-deleted.png`） |
| C2/C3 | 带名注册（trim 落库）+ 有名称行 | 删除后带名重注「`  我的 MacBook Pro  `」 | PASS | 行=`"我的 MacBook Pro\n\n添加于 2026/11/24 13:47:52\n\n从未使用…"`（`shots/34-C3-passkey-named-row.png`） |
| F1 | D1 name 落库 | sqlite 只读 | PASS | `demo_passkey_credentials.name="我的 MacBook Pro"`（trim） |

### 2.4 停用后登录形态

| # | 标准 | 测法 | 结果 | 证据 |
|---|------|------|------|------|
| E4a | 停用 TOTP 后密码登录不再出现验证码输入步 | 登录观察 | PASS | `methods=["passkey"]`（Passkey 为独立第二因子），无 `#totp-code` |
| E4b | 停用后 Passkey 第二步登录不回归 | 点 Passkey 登录 | PASS | 进 workbench |
| E4c | 无第二因子时停用后登录直达 | 删除唯一 Passkey 后登录 | PASS | 直达 workbench，无任何第二步元素 |

## 3. 观察项（非缺陷，如实记录）

1. **防重复注册机制**：`register/options` 按设计下发 `excludeCredentials`（`twofa-manage.ts:150` → `core/webauthn.ts:153`）。同一认证器（同 rpId+userHandle 已有 discoverable credential）第二次注册被浏览器以 `InvalidStateError` 拒绝（"credentials already registered with the relying party"），与名称是否留空无关——标准 CTAP/WebAuthn 防重复行为。初版脚本将「留空添加」排在已有凭证之后导致误报 FAIL，已按正确前提（第一枚留空）重验通过。
2. **Passkey 独立第二因子**：TOTP 停用但账号仍有 Passkey 时，密码登录响应 `{"requires2fa":true,"methods":["passkey"]}`，进入 Passkey 第二步；「停用后登录直达」仅在无任何第二因子凭证时成立（E4a/E4b/E4c 分别验证）。
3. **API 建议项**：`PATCH /api/me/passkeys/:id` 传 `{}`（缺 name 字段）返回 200 并清名——`me.ts:148` 将缺字段与空串统一走 `normalizeTag` 清名语义。用户验收路径（改名/清名）均显式携带 name，不受影响；建议后续对缺字段返回 400 或忽略。

## 4. 失败项

无（0 FAIL，无复现路径需要附）。

## 5. 证据文件清单

- 主脚本（35 PASS / 0 FAIL 全量输出）：`/tmp/demo-qa/qa34-main2.mjs`
- 截图：`/tmp/demo-qa/shots/34-*.png`（A1/A3/A6/A7、B2、C3/C5/C6/C8、E2、prod-login-probe）
- 全量测试日志：`/tmp/demo-qa/qa34-pnpm-test.log`（exit=0）
- 生产 bundle 存档：`/tmp/demo-qa/prod-bundle.js`
- D1 快照输出：见主脚本运行日志 F 段（passkey_credentials / user_2fa / _demo_schema_migrations）
