# 真浏览器 QA 技法

积累自本仓库及同栈项目（WorkerHub 模板系）真浏览器验收（Playwright + Chrome for Testing）的技法笔记。按场景查阅；具体任务的报告仍放各任务自己的 `qa/` 目录。

## 环境与启动

- Playwright 1.65.1：`npm i playwright-core@1.65.1` 即可（不下载浏览器）；本机浏览器缓存在 `~/Library/Caches/ms-playwright`（chromium-1255 / headless_shell-1255）。缺独立 chrome-headless-shell 时，用 `executablePath` 指向缓存里的 Chrome for Testing。
- 端口纪律（多会话并发）：起任何本地服务前先 `lsof -iTCP:<port> -sTCP:LISTEN` 挑空闲端口（8787/8791/8792/889x 常被并行实例占用）。`wrangler dev` 遇 EADDRINUSE 可能静默退出，请求会打到别人的实例上（表现为莫名 403 / 烧掉对方限流窗口）。用后台服务方式启动时，start 后立即 curl 健康端点并看日志确认。
- 代理：本机出网走 `http(s)_proxy=127.0.0.1:7890`。访问外站（生产站点）必须带代理（curl 加 `-x` 或环境变量；Playwright 走系统代理即可）。但 Chromium 不认 `no_proxy`——访问 127.0.0.1/localhost 要 `launch({ proxy: { server, bypass: "127.0.0.1,localhost" } })`，否则页面挂起。只有「把外域 DNS 映射到本机 mock 服务」的场景才加 `--no-proxy-server`，与访问生产站的姿势正好相反。
- bash 后台进程在两次调用之间可能被回收（nohup 挡不住）：「起 worker + 等就绪 + 跑脚本」放在同一次调用里。
- 测试页加 `<link rel="icon" href="data:,">`，防 favicon 404 噪音污染 console 断言。

## 等待与拦截

- 站点有 Service Worker 或常驻请求时 `networkidle` 永不达成：用 `domcontentloaded` + 显式元素等待。
- `locator.count()` 不等待：SPA 异步渲染的断言先 `waitFor({ state: "visible" })` 再取值。
- `page.waitForResponse` 要挂在 `page.goto` 之前，拿到响应体再断言。
- 路由桩想中途切换行为（延迟/失败）不能在请求挂起时 `unroute`：handler 里再 `route.continue()` 会抛 `Route is already handled!` 并崩掉整个脚本。注册一次常驻 handler，用可变标志位（如 `ctl.delay` / `ctl.abort`）切换行为，脚本收尾再 unroute。
- 页面级 `page.route("**/api/files")` 偶发不匹配：改挂 context 级 `route("**/*")` + host 守卫再筛 method/path 才稳定捕获。
- 拦截不到的请求体：XHR `send(Blob)` 的 `postDataBuffer` 是空的。要验证真实上传字节，用 `--host-resolver-rules="MAP <bucket-host> 127.0.0.1:8443"` 把目标域指到本机自签证书 mock 服务（Node https）收真字节；Chromium 加 `--ignore-certificate-errors` + context `ignoreHTTPSErrors`，此时必须 `--no-proxy-server` 防系统代理劫持。收到 PUT 后按被测系统的本地存储路径落库（如 `wrangler r2 object put --local`）。mock 端口避开 8791 等常被遗留进程占用的端口。
- `blob:` URL 存在窗口极短：`MutationObserver`（属性变化回调）+ 10ms 轮询能抓到；50ms 轮询会整个漏掉 blob 阶段。DOM 刚插入又可能被立刻移除的节点同理，在回调里同步读，不要事后再查。

## 组件库（Radix / shadcn）

- Radix 浮层挂在 body 下的 portal：tooltip/弹出层判定别盯触发器，查 `[data-radix-popper-content-wrapper]` 等容器。
- Tooltip「鼠标移开后收起」不能用一次 `page.mouse.move` 跳到远处——hoverable content 下触发器 pointerleave 只清计时器；要连续移动（`mouse.move(x, y, { steps: 25 })`）走完 grace area 才会收起。
- 测「聚焦时显示」别用 click body 清焦点（可能点到侧栏触发导航、浮层元素卸载）：先 Escape 关闭 + `element.blur()`，再 Tab 遍历找触发器（如 `data-slot="tooltip-trigger"` 的 aria-label），用 `aria-describedby` 与浮层 id 对齐确认绑定。
- Dialog 打开时背景内容被 aria-hidden，`getByRole` 对背景元素计数恒为 0——弹窗开着时验证「背后页面状态」要用 API 真值（如 /api/me），别用 UI 计数。
- aria-pressed / disabled 带业务语义时先弄清约定（如「发表按钮 disabled」可能只是空正文校验，不是死锁）；死锁类 bug 的特征是状态位与可见 UI 矛盾（如 aria-pressed=true 且预览区仍在）。

## 视口与设备模拟

- 测 safe-area（`env(safe-area-inset-*)`）：`Emulation.setDeviceMetricsOverride`（含 `mobile: true`）本身不产生 inset，`env()` 仍是 0px。必须再注入 CDP `Emulation.setSafeAreaInsetsOverride { insets: { bottom: 34 } }`。归因要三段测量：初始 0 → setDeviceMetricsOverride 后仍 0 → setSafeAreaInsetsOverride 后非零，三段齐全才算证明。
- iOS「添加到主屏幕」全链路见 `qa-ios-a2hs.md`。
- PWA 可安装性在 macOS 真 Chrome 上无法自动化真实安装：CDP 无 `PWA.install` / `PWA.launch`；`WebAppInstallForceList` 策略即使 OpenStep 写法正确也不安装；osascript/System Events 需辅助功能授权且超时。替代证据链：CDP `getInstallabilityErrors` 为空数组；页面触发 `beforeinstallprompt` 且 `event.prompt` 可调；`Preferences` 的 `content_settings.exceptions.app_banner` 有站点记录；`--app=<url>` 启动的应用窗口 `matchMedia('(display-mode: standalone)').matches === true`。用过 `WebAppInstallForceList` 记得 `defaults delete com.google.Chrome WebAppInstallForceList` 清理。

## 富文本（ProseMirror / TipTap）

- 选整段：点击文字中部 → `Home`（行首可靠）→ `Shift+ArrowRight` 重复「段落 textContent 长度」次，每步断言 `window.getSelection().toString()` 等于期望文本再继续。三击在某些时机（紧跟另一次点击之后）会退化成双击选词（中文分词只选中 2 个字）；`Shift+End` 会跳到全文末尾跨段。否则会出现「格式只套用到部分文字」这类假失败。
- 读段落内所有文本节点的格式（如字号）：用 `closest('p, li, h1..blockquote')` 包住再遍历，不要按文本全等过滤——mark 生效后节点会被拆开。

## 断言纪律

- 断言列表/正文文案不要匹配渲染后的 Markdown（`**粗体**` 被吃掉、换行/括号可能被重组）；造数时注入唯一标记串（如 `QA47-TOP`）再匹配。
- 断言 JSON 响应体先 `JSON.parse` 再匹配字段；直接正则匹配原始响应文本会被转义引号（`\"`）坑成假失败。
- 「关闭弹窗不触发请求」类断言：时间窗基线必须推进到弹窗内合法请求（如错密 403）结算之后，否则合法请求会被误判为意外请求。
- 删除后「列表复原」类断言用轮询（实测有 600ms 才复原的竞态）；固定 sleep 单次采样会误报 FAIL。
- 时钟类断言给 ±1s 容差或注入固定时间，别拿 `Date.now()` 逐毫秒比对。
- 测 passkey/TOTP 增删必须 `try/finally` 走 API 清理兜底：CDP 虚拟认证器随浏览器销毁、私钥不可恢复，遗留 passkey 会成为登录第二因子直接锁号。
- 脚本逐断言 `try/catch` 记 FAIL 继续跑，别一崩全停；前后对照复验时逐条比对。

## 线上产物排查

- esbuild 压缩产物里字符串字面量编译成反引号形态：查特征串要 grep '`data`in'、'let c=JSON.parse' 这种形态，而不是 `"data" in`。api.ts 的 `Network error` 是定位 request() 的好特征串。
- bundle 一致性用 `git show HEAD:<file>` 比对，别信工作区文件；本地构建产物与生产比对时做逐文件 sha256 + 哈希文件名归一化（build-info 的 builtAt/timeZone、CDN 注入的 challenge 脚本除外）。

## GitHub API

- `gh api` 发 JSON body 时 `--input` 与 `-f/-F` 同用：后者被降级为 URL 查询参数、body 丢字段。`git/trees`、`git/refs` 等多字段接口要把全部字段拼进同一个 JSON 走 `--input`。`git/trees` 丢掉 `base_tree` 会生成只含本次条目的树——分支变成删库式坏提交，只能 force-update 修回。创建后先 `gh api git/trees/<sha>?recursive=1` 数条目数与基线一致，再更新 ref。

## QA 产物提交纪律

- QA 报告/证据若随分支提交（如 `qa/qaXXX-report.md` + `qa/evidence-qaXXX/`）：新增 `.md`/`.json` 先 `npx biome format --write`——biome 2.x 会格式化 Markdown 与 JSON，CI 的 format:check 会因此挂掉。
- `build-info.test` 用 git describe 与构建产物比对：build 与 test 之间移动 HEAD（如 force update 分支）会因版本号陈旧假失败，重新 build 再 test 即恢复，不代表产品缺陷。
