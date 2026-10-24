# sidecar

此目录预留给通道、系统代理和启动器脚本。macOS 脚本放 `sidecar/mac/`，Windows 脚本放 `sidecar/win/`。

## sidecar/mac/(M1 通道 sidecar-mac 片交付)

| 文件 | 职责 |
| --- | --- |
| `tunnel-daemon.mjs` | 守护进程入口(CLI:`start` / `restore` / `status`);随包以 `ELECTRON_RUN_AS_NODE` 起,父进程消失后按账本恢复再退出 |
| `daemon-core.mjs` | 守护核心:六态状态机、重连(5 次,退避 2/4/8/16/32 秒)、意图与实际分离;时钟 / 适配器 / 连接器 / bridge 全注入 |
| `ledger.mjs` / `restore.mjs` | 受管操作账本(持久文件)与所有权比对恢复 |
| `connectors.mjs` | 连接器:`ssh-socks`(一人一包受限 SSH,StrictHostKeyChecking=yes + 批次内 known_hosts)与 `loopback-probe`(测试回环);五类受控错误码 |
| `local-bridge.mjs` / `xray-runner.mjs` | 启动包内官方 Xray；同一回环端口支持 SOCKS/HTTP，不记请求日志；父进程死亡也清理内核 |
| `routes.default.json` | 分流数据转换为 Xray 规则：复验、DeepSeek 直连例外、通道 overlay、`geosite:cn` 与国内后缀、localhost、国内/私网 IP；其余经 SSH，保持原域名交通道处理 |
| `adapter-networksetup.mjs` | 真实 macOS 系统设置适配器(networksetup);**加载闸**:仅 `TOOLBOX_REAL_NETWORK_ADAPTER=1` 时可加载,该钥匙只由 `app/main/tunnel/platform/mac.ts` 注入 |
| `socks5.mjs` | 最小 SOCKS5 客户端(复验与上游转发共用) |
| `CONFIG-PACKAGE.md` | 配置包格式说明(`.lxtpack`) |

组件版本：2026-09-07 单窗口接手版，Xray v26.6.1 随包提供。构建前运行 `npm run prepare:xray`，官方归档 SHA256 固定在准备脚本中。只复用 01 朋友包的 SSH + Xray 结构，不带其常驻 launchd 行为。

全部 `.mjs` 为零依赖 plain Node 脚本;自动测试一律经 `--adapter` 注入假适配器 + 回环假 SOCKS,⛔ 在开发与 CI 上调真实网络写命令。

## sidecar/win/(Windows 通道,平台与 mac 侧同构)

与 `sidecar/mac/` 同一套平台无关契约(六态状态机 / 账本恢复 / 连接器 / bridge),差异只在平台原语:

| 文件 | 与 mac 侧的关系 |
| --- | --- |
| `tunnel-daemon.mjs` | 入口同构;默认适配器指向 `adapter-wininet.mjs`,多收 `SIGBREAK` |
| `daemon-core.mjs` | mac 版 + 四处 Windows 增量:连接前 `adapter.preflight` 闸(已有代理控制 / 受管理环境 → 拒且写调用 0)、写入与恢复后 `broadcastSettingsChanged`、致命码增列、`notifyEvent`(睡眠唤醒/网络变化 = 新的恢复小节) |
| `power-events.mjs` | 睡眠唤醒/网络变化事件源:用户级 PowerShell WMI 订阅,行输出 `toolbox:wake` / `toolbox:network-change`;⛔ 服务 ⛔ 计划任务 ⛔ 提权;仅真 win32 由入口拉起 |
| `adapter-wininet.mjs` | Windows 系统设置适配器:按用户 WinINET 四键(HKCU Internet Settings),⛔ WinHTTP ⛔ 服务 ⛔ 提权;ProxyOverride 合并 ⛔ 覆盖;**加载闸**同 mac(钥匙只由 `app/main/tunnel/platform/win.ts` 注入) |
| `connectors.mjs` | mac 版 + 受控码增列(已有代理控制 / 受管理环境 / 组件缺失);`ssh-socks` 只用随包 `bin/ssh.exe`(供应链核准后放入),⛔ 回退系统 OpenSSH |
| `ledger.mjs` / `restore.mjs` / `socks5.mjs` / `vless-*.mjs` / `xray-runner.mjs` / `routes.default.json` | 与 mac 逐字同源 |
| `local-bridge.mjs` | mac 版 + 一处:xray-runner 路径解析到本目录(包内 `sidecar/win/`) |

Xray 内核:`vendor/xray/win-x64/`(xray.exe + geoip.dat + geosite.dat,`npm run prepare:xray` 同一脚本按平台准备);缺内核或任一分流数据时连接按「组件缺失」拒。
