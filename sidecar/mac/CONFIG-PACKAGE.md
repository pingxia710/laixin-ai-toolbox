# 通道配置包格式(`.lxtpack`)

> 本片(工具箱-M1-通道sidecar-mac)拥有格式、校验与事务;01 维护方按本说明出包,打包脚本改动归 01 维护方(本片 ⛔ 碰生产签发脚本)。

## 包形态

一个 `.lxtpack` 文件 = **ustar 归档**(开发期调试也接受等价的目录形态)。包内只允许:

```
manifest.json          # 必填
credentials/<名称>     # 受限 SSH 用户密钥等凭据,至少一个;落盘 0600
hostkey.pub            # 节点主机公钥,known_hosts 行格式:「<主机> <算法> <base64密钥>」
overlay.json           # 可选,签名分流补充
```

安全约束(解包前逐项拒绝):⛔ `../` 越界路径 ⛔ 绝对路径 ⛔ 符号链接 / 硬链接 ⛔ 重名条目。

## manifest.json 字段

| 字段 | 说明 |
| --- | --- |
| `issuer` | 签发方标识,约定值 `laixin-01`(只作格式核,⛔ 自证来源) |
| `configVersion` | 配置版本,正整数;低于 current 即拒(防倒退) |
| `authorizationId` | 客户授权 id,形如 `lx-<a-z0-9>`;客户 ⛔ 手填 |
| `platform` | `mac`(本片) |
| `node.host` / `node.port` | 节点主机与端口;端口 1–65535,**不排除 22**,须与交接端点一致 |
| `node.hostKeyFingerprint` | 主机密钥指纹 `SHA256:...`;**连接时**由 SSH 层严格核验,不符即拒(节点身份不符) |
| `node.sshUser` | 受限 SSH 用户名 |
| `issuedAt` / `expiresAt` | 签发与到期时刻(ISO 8601) |
| `files` | 内容清单:相对路径 → sha256(hex);包内非 manifest 文件必须全部被列出 |
| `signature` | base64 Ed25519 签名(对 manifest 去 `signature` 后的规范 JSON);**空 = 未签名** |

## 信任三档(界面逐字)

1. `来源:已签名(测试密钥)` —— 签名非空且用随包公钥验过。**待供给**:01 维护方打包脚本加签 + 公钥随工具箱发布;供给到位前只认测试密钥对(界面标「测试密钥」)。
2. `来源:未签名(内部测试包)` —— 签名为空且整包摘要 ∈ 测试构建预置白名单(`TOOLBOX_TEST_PACKAGE_WHITELIST`,01 维护方另行交接摘要);**客户构建没有白名单 ⇒ 拒绝一切未签名包**。
3. 拒绝 —— 签名非空无公钥(⛔ 降成未签名)/ 验签失败 / 未签名不在白名单 / 无 manifest / 清单 sha256 不符 / 签发方不对 / 平台不符 / 节点主机不一致 / 端口越界 / 凭据引用逃出 / 已过期 / 授权 id 格式不合 / 版本倒退 / overlay 越界。

整包摘要 = 对「排序后的 `<sha256>  <相对路径>` 行(含 manifest.json)」再取 sha256 hex。

## overlay.json（分流补充）

只允许 `tunnelDomains` 与 `directDomains` 两个域名后缀数组；至少提供其中一个。`tunnelDomains` 保留原来把指定域名改走通道的能力；`directDomains` 补充普通直连后缀，仅正式签发身份（`signed-issuer`）可用，测试签名和未签名白名单均不可增加直连。

规则合计最多 256 条，overlay 文件最多 64 KiB。只接受小写 ASCII 域名标签、至少两段；拒绝 IP、URL、端口、通配符、空标签、顶级后缀、常见公共复合后缀和共享托管后缀。两组之间任何父子域重叠、任何与 DeepSeek 保护域（`deepseek.com / deepseek.cn / deepseek.ai`）重叠，均拒绝整包。后缀检查是保守本地边界，并非完整公共后缀库；签发人仍需确认域名归属及所需范围。

实际优先级为：复验目标走通道 → DeepSeek 保护直连 → tunnelDomains → GeoSite 国内域名与默认/补充直连后缀 → 本机/GeoIP → 未命中走通道。Mac 与 Windows 相同。规则进入文件摘要和签名，跟随 configVersion 应用；低版本仍拒绝。运营签发示例见 [签名规则更新](../../docs/signed-route-updates.md)。

## 落盘与事务

数据目录 `<userData>/tunnel/`:

- `imports/<批次id>/` —— 每次导入一个批次目录(批次 id = 时刻 + 随机),凭据 0600,配置引用只指向本批次
- `current` / `pending` / `rollback` —— 指针文件(原子写);`current` 与其批次目录在导入全程一个字节不动
- `staging/<批次id>/` —— 解包暂存;取消 / 失败 / 崩溃只清本次 staging
- `intent.json`（意图）/ `state.json`（实际）/ `ledger.json`（恢复账本）/ `connection-verified.json`（复验成功的时间；连接意图不能替代）/ `xray-bridge.json`（不含凭据的内核运行配置）。Xray 不记录请求日志。

`applyPending()` 只在「未配置 / 已停止并恢复原设置 / 用户主动断开」放行;动作 = current 原子改指 pending 批次、pending 清空、旧 current 保留为回退候选(下一次成功应用后清理)。
