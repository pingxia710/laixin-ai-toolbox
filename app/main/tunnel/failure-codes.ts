// FB-3 件一:回传数据的可信度底线——「回传的原因必须是我们认得的码」。
// 这张表是全系统「认得的失败码」唯一清单,两端共用同一份:
//  · 客户端出口(app/main/tunnel/tunnel-service.ts reportFailure):表外的码一律归 UNKNOWN 再上传,
//    真实文本(可能含路径)留在本机日志,⛔ 冒充已知原因;
//  · 后台入口(tools/channel/service.ts recordDiagnosis):字符集闸放行但表外的码,收下并归入
//    UNKNOWN 桶单独计数——客户端将来加新码不会静默丢数据,UNKNOWN 占比 = 白名单没覆盖的量。
// ⛔ 用这张表拒收:拒收会让新码静默丢数据;表外的正确去处永远是 UNKNOWN。
// 各族码的权威出处(加新码:先在产生它的模块里定义,再同步进这张表):
//  · NETWORK_*  ← app/main/tunnel/account-client.ts 与 tunnel-service.ts accountFailure 表
//  · PACKAGE_*  ← app/main/tunnel/package-format.ts(PackageReject)
//  · TUNNEL_*   ← tunnel-service / transactions / import-service / supervisor 及守护 daemon-core
//  · 中文受控码 ← sidecar/{mac,win}/connectors.mjs CONTROL_CODES(八类)+ daemon-core(配置缺失等)
//  · LEDGER_*   ← sidecar/shared/ledger.mjs(LedgerError)
export const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  // UNKNOWN 本身是受控哨兵:客户端判不出原因时上传的就是它。
  'UNKNOWN',
  // 账号/后台交互失败码(NetworkAccountError 的 message 即码;accountFailure 表同款)
  'NETWORK_APPLICATION_PENDING',
  'NETWORK_AUTHORIZATION_UNAVAILABLE',
  'NETWORK_DISCONNECT_REQUIRED',
  'NETWORK_ENDPOINT_INVALID',
  'NETWORK_LEASE_CONTINUATION',
  'NETWORK_LEASE_INVALID',
  'NETWORK_LOCAL_BUSY',
  'NETWORK_LOGIN_REQUIRED',
  'NETWORK_NO_APPLICATION',
  'NETWORK_RESPONSE_INVALID',
  'NETWORK_ROUTE_NOT_FOUND',
  'NETWORK_SERVICE_UNAVAILABLE',
  'NETWORK_SESSION_CHANGED',
  // 配置包校验失败码(PackageReject)
  'PACKAGE_AUTH_ID_INVALID',
  'PACKAGE_AUTH_ID_MISMATCH',
  'PACKAGE_CONTENT_HASH_MISMATCH',
  'PACKAGE_CREDENTIAL_ESCAPE',
  'PACKAGE_ENTRY_UNSAFE',
  'PACKAGE_EXPIRED',
  'PACKAGE_HOST_FINGERPRINT_MISMATCH',
  'PACKAGE_HOST_FINGERPRINT_MISSING',
  'PACKAGE_ISSUER_MISMATCH',
  'PACKAGE_MALFORMED',
  'PACKAGE_MANIFEST_MISSING',
  'PACKAGE_NODE_HOST_MISMATCH',
  'PACKAGE_OVERLAY_NOT_ALLOWED',
  'PACKAGE_PLATFORM_MISMATCH',
  'PACKAGE_PORT_INVALID',
  'PACKAGE_PROTOCOL_INVALID',
  'PACKAGE_SIGNATURE_INVALID',
  'PACKAGE_SIGNATURE_NO_KEY',
  'PACKAGE_SSH_USER_MISSING',
  // 甲-8:读取前尺寸闸——超大文件不是来信的配置包,⛔ 与「读失败」(TUNNEL_LOCAL_READ_FAILED)混同一归因。
  'PACKAGE_TOO_LARGE',
  'PACKAGE_UNSIGNED_UNTRUSTED',
  'PACKAGE_VERSION_CONFLICT',
  'PACKAGE_VERSION_REGRESSION',
  // 主进程通道动作失败码
  'TUNNEL_BUSY',
  'TUNNEL_COMPONENT_MISSING',
  'TUNNEL_CONFIG_INVALID',
  // N-07:本地写入失败(磁盘满/数据目录不可写)的细分码,与「恢复在途」的 NETWORK_LOCAL_BUSY 分开,
  // ⛔ 让磁盘满以已知「本地忙」的身份污染归因。
  'TUNNEL_LOCAL_WRITE_FAILED',
  // 甲-6返工(④):读客户选的配置包失败(被移走/没有读取权限)与写数据目录失败分开归因——
  // ⛔ 让「请重新选择包」的读失败在后台被聚合成「清磁盘」的写失败。
  'TUNNEL_LOCAL_READ_FAILED',
  // N-18:非预期程序错误(TypeError 等,不带 fs 错误码)的细分码,与真写入失败 TUNNEL_LOCAL_WRITE_FAILED
  // 分开——⛔ 让程序错误冒充「写入失败」指使客户清磁盘、后台分不开两类归因。
  'TUNNEL_LOCAL_UNEXPECTED',
  'TUNNEL_NOT_CONFIGURED',
  'TUNNEL_NO_PENDING',
  'TUNNEL_PENDING_MISSING',
  'TUNNEL_POINTER_INVALID',
  'TUNNEL_PROBE_UNAVAILABLE',
  'TUNNEL_REPAIR_CANCELLED',
  'TUNNEL_REPAIR_LOCAL_FAILURE',
  'TUNNEL_REPAIR_TIMEOUT',
  'TUNNEL_REPAIR_UNCONFIRMED',
  'TUNNEL_RESTORE_INCOMPLETE',
  // N-23:一次性恢复子进程的两类受控失败(supervisor 落盘 state.json)。基线静默吞掉,
  // 客户对着「未完成(进程中断)」永远转圈;给独立码,后台才分得清「超时」和「没起来」。
  'TUNNEL_RESTORE_TIMEOUT',
  'TUNNEL_RESTORE_SPAWN_FAILED',
  'TUNNEL_SETTINGS_NOT_APPLIED',
  // 连接争抢止损(2026-09-15)。这四个码本身就是「点名冲突方」的载体:后台按码聚合即可分出
  // 「另一份来信」「其他软件」「认不出」三类,⛔ 上传路径/命令行来说明是谁。
  'TUNNEL_PEER_LAIXIN_RUNNING',
  'TUNNEL_SETTINGS_CONTEST_STOPPED',
  'TUNNEL_WRITE_RIGHT_HELD',
  'TUNNEL_WRITE_RIGHT_UNKNOWN',
  'TUNNEL_START_CANCELLED',
  'TUNNEL_STATE_NOT_ALLOWED',
  // 守护写进 state.json 的受控码(connectors CONTROL_CODES + daemon-core)
  '端口占用',
  '节点身份不符',
  '授权失效',
  '配额或授权问题',
  '上游不可达',
  '已有代理控制',
  '受管理环境',
  '组件缺失',
  '配置缺失',
  'DAEMON_CRASH',
  'INTENT_FILE_CORRUPT_RESET',
  'TUNNEL_AUTHORIZATION_EXPIRED',
  'TUNNEL_AUTHORIZATION_INVALID',
  'TUNNEL_CONNECTION_CANCELLED',
  'TUNNEL_RESIDENT_SELF_HEAL',
  'TUNNEL_SETTINGS_BUSY',
  'TUNNEL_SETTINGS_CONTESTED',
  'TUNNEL_VERIFY_UNCONFIRMED',
  // 恢复账本失败码(LedgerError)
  'LEDGER_CORRUPT',
  'LEDGER_UNREADABLE'
])
