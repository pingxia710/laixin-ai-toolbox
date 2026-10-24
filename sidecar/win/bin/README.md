# Windows sidecar binaries

本目录的 `ssh.exe` 是随包 OpenSSH 客户端(SSH 稳定版连接器专用;VLESS/REALITY 包不依赖,
它们使用 `vendor/xray/win-x64/` 的 Xray 内核,见 `local-bridge.mjs` 的 `xrayExecutable()`)。

## 来源(固定,升级必须重新核准并更新本表)

- 项目:微软官方 Win32-OpenSSH 发布件 <https://github.com/PowerShell/Win32-OpenSSH>
- 固定版本:`v9.5.0.0p1-Beta`(2023-12-18 发布;与 Windows「可选功能」内置的 OpenSSH
  客户端同源,现网验证最充分,故取它而非更新的 Preview)
- 下载件:`OpenSSH-Win64.zip`(发布件原包)
- 发布件原包 SHA256:`bd48fe985d400402c278c485db20e6a82bc4c7f7d8e0ef5a81128f523096530c`

## 随包文件与 SHA256

| 文件 | SHA256 |
| --- | --- |
| `ssh.exe` | `e41e50a22dffeae8bb13bce4cb47b6c4aa0de4cdecbd62ef79d5046adc05a8b1` |
| `libcrypto.dll`(ssh.exe 唯一外部依赖) | `065d3a16b418dfe5647c56c8a1787ac540b13299bdf35f69e9980525804cb9ab` |
| `LICENSE.txt` | `e6a25da96c2fccdc025caad56d99f87851ec3fe814a3cea83f2bc77ffc800681` |
| `NOTICE.txt` | `2cd5f5d0064bc909dfe0f0fc8f4787882c7c379f2730d89e5faa0c2bc57c620b` |

许可:OpenSSH(BSD 风格)与随附第三方许可,全文见 `LICENSE.txt` / `NOTICE.txt`。

## 组件闸语义

- `bin/ssh.exe` 缺失时,`ssh-socks` 连接器在真实起连接时按受控码 `组件缺失` 拒绝
  (connectors.mjs);该码在守护致命码表内:立即停,⛔ 每 60 秒无限低频重试。
- 启动组件闸(sidecar-path.ts)把它列为**按需**项:只有分配到 SSH 稳定版的配置才要求;
  一键诊断对有无如实展示(`随包 OpenSSH(SSH 稳定版需要):有/无`)。
