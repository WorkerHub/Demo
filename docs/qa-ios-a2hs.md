# iOS 模拟器验证「添加到主屏幕」（A2HS）全链路

用真实 Safari 在 iOS 模拟器跑通「添加到主屏幕」并取证。坐标以 iOS 27.2 模拟器（iPhone 尺寸）实测，系统升级后需重新定位。

## 操作序列

- Safari Page Menu (x114, y816) → Share (215, 351) → View More (332, 764) → Add to Home Screen (154, 626) → Add (353, 99)。
- 首次 Add 常只进 `installd.staging` 不落地：`xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` 重启模拟器后重做即成。

## idb 使用

- idb（本机二进制 + `uv` 的 fb-idb）：模拟器重启后必须 `pkill -f idb_companion` 再 `idb list-targets` 自动拉起 companion，否则报 `dtuhidd invalidated`；手动 `--grpc-port` 启动会因 socket 不匹配全废。

## 证据位置（模拟器 data 目录）

- WebClip：`data/Library/WebClips/<uuid>.webclip`（Info.plist `FullScreen=true`、`ApplicationManifest` 含 raw_json）。
- 主屏应用：`data/Containers/Bundle/Application/<uuid>/<App>.app`（`Icon.png` 即主屏图标）。
- Service Worker 注册：MobileSafari 容器内 `ServiceWorkerRegistrations-8.sqlite3`。

## standalone 判定

- `Info.plist FullScreen` + 前台 AX 标签 `Application|'Web'` + 截图无 Safari chrome。真机可读的 `navigator.standalone` 在模拟器读不到，不能作为依据。
