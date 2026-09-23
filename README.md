# 来信 AI 工具箱

来信 AI 工具箱是一款面向 Windows 和 macOS 的桌面客户端，用于管理来信网络服务，并为 Codex、Claude Code 和 Hermes 提供官方下载入口、版本检测与模型 API 配置。

## 下载

- [GitHub Releases](https://github.com/pingxia710/laixin-ai-toolbox/releases)
- [来信 AI 工具箱](https://laixin.work/)

官方版本的更新清单使用 Ed25519 签名，客户端在安装前还会校验文件大小、SHA-256 和应用包摘要。GitHub 与官网提供的是同一份版本文件；客户端优先使用 GitHub，失败时自动回到官网。

## 本地开发

需要 Node.js 22 或更高版本。

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm run lint
npm run typecheck
npm test
```

`npm test` 会下载并校验测试所需的 Xray-core 官方文件，首次运行需要能够访问 GitHub。

构建 macOS 版本：

```bash
TOOLBOX_ACCOUNT_ORIGIN=https://example.com/ TOOLBOX_UPDATE_ORIGIN=https://example.com/ npm run build
```

`TOOLBOX_ACCOUNT_ORIGIN` 是账号服务地址。自行构建时请使用自己的服务地址；未设置时，账号服务保持未配置状态，不会自动接入来信生产账号。

## 仓库范围

本仓库公开桌面客户端、通用网络 sidecar、构建脚本和客户端测试。生产后台、支付配置、部署脚本、发布签名私钥与客户数据不在本仓库中。

Xray-core 在构建时从其官方 GitHub Release 下载并进行固定 SHA-256 校验，许可证随最终安装包提供。Windows 原生依赖 Koffi 通过 npm 官方包准备。

## 参与项目

提交问题或代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 的方式反馈，不要在公开 Issue 中粘贴账号、密钥或完整诊断文件。

## 许可证

来信 AI 工具箱客户端代码按 [MIT License](LICENSE) 开源。第三方组件继续适用各自许可证。
