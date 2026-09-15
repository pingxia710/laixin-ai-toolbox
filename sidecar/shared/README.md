# sidecar/shared · mac/win 共享源

本目录是 mac/win 字节级相同 sidecar 文件的**唯一源**;`sidecar/mac/` 与 `sidecar/win/`
里的同名文件是构建期副本(`node scripts/prepare-sidecar.mjs`,由 vitest globalSetup、
`npm run build`、`build:pilot` 与 `build-account`/`build-channel`/`issuer` 运维脚本自动执行),
副本不入库(.gitignore),平台目录在复制后保持自包含。

- 平台特有文件(mac:`adapter-networksetup.mjs`;win:`adapter-wininet.mjs`、
  `wininet-settings.ps1`、`bin/`)仍直接提交在各自平台目录,本脚本永不覆盖。
- 改这些文件时只改 `shared/` 里的这份;运行任何测试或构建前副本会自动刷新。
- 相对导入说明:`tunnel-daemon.mjs`、`daemon-core.mjs` 等引用的 `./connectors.mjs`、
  `./power-events.mjs` 是平台特有文件,这些引用只在副本所在的平台目录内成立。
  因此主进程与工具链的 import 一律指向平台目录(如 `sidecar/mac/x.mjs`)而非 `shared/`,
  打包与运行链路不受影响;指向平台目录不再有漂移风险——平台目录里的共享文件
  永远是 `shared/` 的生成副本,与 win 侧逐字节一致。
