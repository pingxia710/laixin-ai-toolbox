/**
 * A public, machine-readable boundary for the 27 common customer environments.  It describes
 * what the Toolbox can actually observe or change; it must not be used as evidence that a
 * particular customer's environment has already been scanned or repaired.
 */
export const environmentChecklistDetectionModes = ['automatic', 'user-action', 'unsupported'] as const
export type EnvironmentChecklistDetectionMode = typeof environmentChecklistDetectionModes[number]

export const environmentChecklistHandlingModes = ['automatic-fix', 'user-action', 'do-not-do'] as const
export type EnvironmentChecklistHandlingMode = typeof environmentChecklistHandlingModes[number]

/** Existing implementation seams referenced by checklist entries. */
export const environmentChecklistCapabilities = [
  'trusted-native-runtime-inventory',
  'native-route-runner',
  'configuration-root-resolution',
  'configuration-target-protection',
  'hidden-state-scan',
  'hidden-state-cleanup-and-restore',
  'managed-policy-protection',
  'gateway-request-rewrite',
  'restart-guidance',
  'provider-route-probe'
] as const
export type EnvironmentChecklistCapability = typeof environmentChecklistCapabilities[number]

export interface EnvironmentChecklistStep<Mode extends string> {
  readonly mode: Mode
  /** Customer-readable description of the exact observation or action scope. */
  readonly strategy: string
  /** Empty means that this step deliberately relies on customer or administrator action. */
  readonly capabilities: readonly EnvironmentChecklistCapability[]
}

export interface EnvironmentChecklistItem {
  readonly id: number
  readonly title: string
  readonly detection: EnvironmentChecklistStep<EnvironmentChecklistDetectionMode>
  readonly handling: EnvironmentChecklistStep<EnvironmentChecklistHandlingMode>
  /** Why the Toolbox stops at the stated scope instead of guessing or changing more state. */
  readonly safetyBoundaryReason: string
}

const automatic = (
  strategy: string,
  capabilities: readonly EnvironmentChecklistCapability[]
): EnvironmentChecklistStep<'automatic'> => ({ mode: 'automatic', strategy, capabilities })

const userAction = (
  strategy: string,
  capabilities: readonly EnvironmentChecklistCapability[] = []
): EnvironmentChecklistStep<'user-action'> => ({ mode: 'user-action', strategy, capabilities })

const unsupported = (strategy: string): EnvironmentChecklistStep<'unsupported'> => ({ mode: 'unsupported', strategy, capabilities: [] })

const automaticFix = (
  strategy: string,
  capabilities: readonly EnvironmentChecklistCapability[]
): EnvironmentChecklistStep<'automatic-fix'> => ({ mode: 'automatic-fix', strategy, capabilities })

const doNotDo = (
  strategy: string,
  capabilities: readonly EnvironmentChecklistCapability[] = []
): EnvironmentChecklistStep<'do-not-do'> => ({ mode: 'do-not-do', strategy, capabilities })

/**
 * The checklist follows the research package's fixed 1–27 order.  A row is a capability
 * contract, not a completed diagnosis: callers must show it alongside a fresh scan result.
 */
export const environmentChecklist = [
  {
    id: 1,
    title: 'Claude Code 多套安装并存（原生、npm、brew、winget 或旧目录）',
    detection: automatic(
      '仅枚举受信任的官方原生候选并确认实际可验证路径；不会执行 PATH、npm 或 brew 找到的同名包装器，也不声称已枚举全部安装。',
      ['trusted-native-runtime-inventory', 'native-route-runner']
    ),
    handling: userAction('客户决定保留哪套原生安装并移除旧版或包装器；随后用该原生路径重新验收。'),
    safetyBoundaryReason: 'PATH 命中可能是客户脚本或第三方包装器，工具箱不能把它当作官方 CLI 执行。'
  },
  {
    id: 2,
    title: 'Claude Code 版本过旧，切换后不重读配置或旧 helper 误报失败',
    detection: automatic(
      '真实原生路径验收记录当前请求结果；不会仅凭版本号断言已兼容，也不会把版本检查当作阻断切换的替代品。',
      ['native-route-runner', 'provider-route-probe']
    ),
    handling: automaticFix(
      '网关保留已实测可用的 beta 头、缓存和 context 字段，不删改客户端发来的兼容扩展；若客户端不重读配置，重启提示会要求客户新开会话或重新启动。',
      ['gateway-request-rewrite', 'restart-guidance']
    ),
    safetyBoundaryReason: '不能伪造旧客户端已经读取新配置，也不能通过篡改客户安装来强制升级。'
  },
  {
    id: 3,
    title: 'VS Code 扩展携带私有 Claude CLI',
    detection: unsupported('工具箱不扫描 VS Code 扩展目录，也不把“系统找不到 claude”解释为可接管扩展私有 CLI。'),
    handling: doNotDo('不写 VS Code 扩展私有的 claudeCode.environmentVariables，也不宣称该扩展已接入。'),
    safetyBoundaryReason: '扩展私有配置和进程所有权不属于工具箱，写入会越过客户或组织的编辑器管理边界。'
  },
  {
    id: 4,
    title: 'Claude Desktop（含 Microsoft Store MSIX）双配置或 PATH 抢占',
    detection: unsupported('工具箱不枚举 Claude Desktop 的 APPDATA、LOCALAPPDATA 或商店容器配置，也不把桌面应用识别成 Claude Code。'),
    handling: doNotDo('不写 Desktop 的第三方推理配置，不改变 WindowsApps PATH，也不伪装为 Desktop 已支持。'),
    safetyBoundaryReason: '桌面应用的配置协议、容器权限和客户账号状态与 Claude Code 不同，自动写入会造成不可验证的影响。'
  },
  {
    id: 5,
    title: '代理环境变量、系统代理、PAC 或专线影响本机网关',
    detection: automatic(
      '隐形状态扫描会列出 shell 启动项或 Windows 环境变量中的代理变量，以及系统代理的活动状态；PAC、专线和出口路由只报告，不自动改变。',
      ['hidden-state-scan']
    ),
    handling: userAction('客户或管理员自行确认 127.0.0.1 进入 NO_PROXY，并按现有网络策略处理代理环境变量。'),
    safetyBoundaryReason: '工具箱不得自动改 PAC、系统代理、专线或出口路由。'
  },
  {
    id: 6,
    title: '公司受管配置覆盖个人配置',
    detection: automatic(
      '当运行上下文已明确标记为受管时，配置目标发现会返回受管锁定；未知上下文保持未知，不声称已读遍所有公司策略。',
      ['configuration-target-protection', 'managed-policy-protection']
    ),
    handling: doNotDo('不写受管配置、不尝试绕过策略；提示客户联系公司管理员解除或下发允许的配置。'),
    safetyBoundaryReason: '组织策略拥有更高优先级，写入或规避会违反客户的设备管理边界。'
  },
  {
    id: 7,
    title: '项目级 .claude/settings*.json 留有旧环境变量',
    detection: automatic(
      '在已选择的项目目录内，配置目标发现会区分项目级与用户级来源；没有明确项目选择时不猜测工作目录。',
      ['configuration-target-protection']
    ),
    handling: userAction('没有尚未收尾的接管或恢复状态，且配置来源可安全处理时，模型 API 页面提供“选择项目目录并修复”；受管策略、启动参数或不可读配置会明确阻止。客户明确选择项目级目标后，工具箱才写入自己的受管段；其余旧项目配置由客户确认后清理。'),
    safetyBoundaryReason: '项目配置可能属于仓库和团队，不能因一次个人切换而自动改写。'
  },
  {
    id: 8,
    title: 'shell rc 旧 export 或 Windows 用户/系统环境变量残留',
    detection: automatic(
      '隐形状态扫描会逐条列出白名单 API 变量所在的 shell 文件和行号，或 Windows 注册表位置；Key 会脱敏。',
      ['hidden-state-scan']
    ),
    handling: automaticFix(
      '客户明确点“停用”后，工具箱会先备份，再只注释精确命中的 shell export；Windows 注册表按键备份后删除该值。撤销只使用本次备份，不覆盖之后的手工修改。',
      ['hidden-state-cleanup-and-restore']
    ),
    safetyBoundaryReason: '不能删除可能承载其他命令的 rc 行，也不能擅自写系统或公司管理的环境变量。'
  },
  {
    id: 9,
    title: 'CC Switch 残留 loopback BASE_URL，而原代理已停止',
    detection: automatic(
      '隐形状态扫描会列出旧 API 环境变量的文件、行号和影响的软件；不会把 loopback 地址自动归因成某个 CC Switch profile。',
      ['hidden-state-scan', 'provider-route-probe']
    ),
    handling: automaticFix(
      '接管时工具箱只写自己的受管连接并保存接管前快照；解除接管或恢复原接入按快照执行，不会停止或删除 CC Switch。',
      ['configuration-target-protection', 'hidden-state-cleanup-and-restore']
    ),
    safetyBoundaryReason: 'CC Switch 可能同时服务其他 profile，工具箱不能擅自停服务、删配置或把 generic loopback 当作唯一原因。'
  },
  {
    id: 10,
    title: 'ccs 残留 CLAUDE_CONFIG_DIR，settings 是 symlink 或 profile 目录',
    detection: automatic(
      '配置根解析遵从有效的 CLAUDE_CONFIG_DIR，不回退到默认 ~/.claude，也不把该目录当成可执行程序来源。',
      ['configuration-root-resolution']
    ),
    handling: userAction('客户确认要影响的 ccs profile；工具箱不跟随或重写 symlink，也不替客户选择其它 profile。'),
    safetyBoundaryReason: '一个配置根可服务多个 profile，自动改写链接目标会扩大到未选账号或项目。'
  },
  {
    id: 11,
    title: 'Codex auth.json 残留 ChatGPT 登录或第三方 Key',
    detection: automatic(
      'Codex 解除接管时只给出安全的认证状态结论，不回传 auth.json 内容、令牌或 Key。',
      ['configuration-target-protection']
    ),
    handling: doNotDo('第三方模型只写自定义 provider 路由，不修改或删除 auth.json；恢复官方登录按 Codex 的登录流程由客户完成。'),
    safetyBoundaryReason: 'auth.json 承载客户登录与其他工具 Key，工具箱不能用清空凭据来伪造“恢复官方”。'
  },
  {
    id: 12,
    title: 'Codex 使用钥匙串模式，没有 auth.json',
    detection: unsupported('工具箱不读取 macOS 钥匙串、Windows Credential Manager 或 Codex 私有凭据存储。'),
    handling: doNotDo('不注入、迁移或删除钥匙串凭据；第三方模型仍只通过自定义 provider 配置接入。'),
    safetyBoundaryReason: '操作系统凭据库包含账号秘密，访问或改写会越过最小权限和客户登录控制。'
  },
  {
    id: 13,
    title: 'CODEX_HOME、HERMES_HOME 或 CLAUDE_CONFIG_DIR 被改，含 WSL 与 Windows 混用',
    detection: automatic(
      '配置根解析按已验证的环境变量定位三款软件的用户级配置，默认目录只在变量缺失时使用；自定义 HERMES_HOME 下的启动器仍须满足固定虚拟环境布局和官方 console-script 形态。',
      ['configuration-root-resolution', 'configuration-target-protection']
    ),
    handling: automaticFix(
      '在目标可读、可写且未受管时，工具箱写入该软件实际配置根；命令行覆盖、未知启动上下文和受管根会明确阻断写入。',
      ['configuration-root-resolution', 'configuration-target-protection']
    ),
    safetyBoundaryReason: '不能猜测 WSL 与 Windows 的对应目录，也不能为了成功写入回退到错误的默认根。'
  },
  {
    id: 14,
    title: '配置路径只读，或 sudo npm 造成 root 属主',
    detection: unsupported('当前配置目标只把不可读或不可写视为阻断，不自动诊断属主、sudo 历史或给出路径细节。'),
    handling: userAction('客户或设备管理员在本机按实际路径修复权限与属主后，再重新执行配置。'),
    safetyBoundaryReason: '自动 chown、sudo 或权限放宽会改变客户设备安全边界。'
  },
  {
    id: 15,
    title: 'OneDrive 同步用户目录或已知文件夹重定向导致并发写入',
    detection: unsupported('工具箱不扫描 OneDrive、重解析点或同步客户端状态，也不据路径名称假定存在重定向。'),
    handling: doNotDo('不自动迁移 CONFIG_DIR、不修改同步策略；客户可选择将配置根放到本地稳定目录后重新接入。'),
    safetyBoundaryReason: '迁移用户配置会影响同步、备份和其他设备，且可能与同步客户端发生竞争写入。'
  },
  {
    id: 16,
    title: '用户名路径含非 ASCII 或空格，原生软件可能存在路径兼容问题',
    detection: unsupported('工具箱不以用户名字符集或空格推断原生软件一定会失败。'),
    handling: doNotDo('不自动新建、搬迁或改写配置根；若真实原生验收失败，由客户选择可控的本地纯 ASCII 配置根。'),
    safetyBoundaryReason: '路径迁移会改变客户已有客户端、同步和权限关系，不能仅凭字符规则自动执行。'
  },
  {
    id: 17,
    title: 'Windows 缺少 Git Bash 或 PowerShell 执行策略阻止脚本',
    detection: unsupported('工具箱不依赖 Git Bash 或 PowerShell 脚本来接管模型配置，也不扫描客户执行策略。'),
    handling: userAction('客户按原生安装说明修复 CLI 安装或执行策略，再使用受信任原生路径验收。'),
    safetyBoundaryReason: '修改执行策略会影响整台设备的脚本安全，不属于模型 API 配置的自动修复范围。'
  },
  {
    id: 18,
    title: 'WSL 内 node/npm 实际指向 Windows 版本',
    detection: unsupported('工具箱不通过 /mnt/c 路径或 node/npm 版本猜测跨系统运行时是否可用。'),
    handling: userAction('客户在目标系统内安装并选择原生 Linux 或 Windows CLI，再重新进行真实路径验收。'),
    safetyBoundaryReason: '替换 Node/npm 会影响项目依赖和系统运行时，不能由模型配置模块擅自处理。'
  },
  {
    id: 19,
    title: '已订阅登录同时又放入 API Key',
    detection: userAction('工具箱不读取 .credentials.json、钥匙串或订阅令牌内容；客户通过应用的认证状态提示确认当前登录方式。'),
    handling: doNotDo('不替客户删除 API Key、登录令牌或强制切换认证方式；第三方模型配置与官方订阅状态分别保留。'),
    safetyBoundaryReason: '认证优先级会影响账号、套餐和费用，工具箱不能在不知客户意图时改变凭据。'
  },
  {
    id: 20,
    title: 'ANTHROPIC_API_KEY 曾被 Claude 记录为 rejected',
    detection: automatic(
      '隐形状态扫描会在实际 CLAUDE_CONFIG_DIR 下识别已拒绝 Key 的记录，以及未完成的 Claude 首次引导；不展示 Key。',
      ['hidden-state-scan']
    ),
    handling: userAction(
      '客户点「停用」后，工具箱只在 .claude.json 写入 hasCompletedOnboarding 一个键：先备份、可撤销，rejected 记录和其余内容都不动。请在 Claude Code 中检查该 Key 和历史记录后重新验证。'
    ),
    safetyBoundaryReason: '自动批准 Key 或改写完整 .claude.json 会越过客户对凭据和其它 Claude 状态的确认。'
  },
  {
    id: 21,
    title: '兼容层不接受 beta 头、context_management 或 adaptive thinking',
    detection: automatic(
      '真实原生路由验收和上游探测以请求结果识别兼容失败，不将 curl 成功当作原生客户端成功。',
      ['native-route-runner', 'provider-route-probe']
    ),
    handling: automaticFix(
      '网关保留已实测可用的 beta 头、缓存和 context 字段；只对 DeepSeek chat 的 json_schema、JSON 提示、thinking 与工具历史做有证据的兼容改写。',
      ['gateway-request-rewrite']
    ),
    safetyBoundaryReason: '改写只覆盖已知字段；未知协议字段不能猜测删除或伪造推理内容。'
  },
  {
    id: 22,
    title: '端点只有 chat/completions，却希望接入 Codex',
    detection: automatic(
      'Codex 的真实原生路由验收要求 responses 语义；响应不满足时记录为失败，而不是以其他 shell 或 curl 的成功替代。',
      ['native-route-runner', 'provider-route-probe']
    ),
    handling: doNotDo('不把 Codex 请求偷偷改投 chat/completions，也不把该端点标记为 Codex 已支持；客户选择具备 responses 兼容性的服务。'),
    safetyBoundaryReason: '错误协议翻译会让工具调用、流式结果和错误语义失真，客户会在真实使用时失败。'
  },
  {
    id: 23,
    title: '国产端点 base_url 写法不同（/anthropic 后缀、/v1 根）',
    detection: userAction('客户从工具箱固定的服务商入口选择 API 或套餐类型；不接受任意自定义 base_url 并以一次网络请求猜测其协议。'),
    handling: automaticFix(
      '工具箱按已支持服务商合同写入固定兼容路径，并由网关处理已知请求差异；未收录的地址明确不自动接入。',
      ['configuration-target-protection', 'gateway-request-rewrite']
    ),
    safetyBoundaryReason: '任意 URL 探测可能命中内网或非预期服务，且不能安全推断其鉴权和协议。'
  },
  {
    id: 24,
    title: '运行中的会话不重读配置',
    detection: automatic(
      '重启提示只读取固定进程名的存活状态；命令失败返回“未知”，不声称客户已经重启。',
      ['restart-guidance']
    ),
    handling: userAction('Codex 重新打开终端或 ChatGPT/Codex 桌面版，Claude Code 新开会话，Hermes 在当前或新会话发送一条消息确认。'),
    safetyBoundaryReason: '工具箱不能终止客户正在运行的会话或替客户发送可能消耗套餐的验证消息。'
  },
  {
    id: 25,
    title: '同机多账号或多个配置目录（例如 .claude-b）',
    detection: userAction('客户提供或选择明确的 CLAUDE_CONFIG_DIR、CODEX_HOME 或 HERMES_HOME；工具箱不枚举目录变体并猜测账号归属。'),
    handling: userAction('仅对客户明确选定的配置根写入，再用该根的原生客户端验收。'),
    safetyBoundaryReason: '自动选择相似目录可能把一个账号的 Key、模型或恢复快照写到另一个账号。'
  },
  {
    id: 26,
    title: '网关 /v1/models 重定向或超过 3 秒',
    detection: unsupported('工具箱不把 /v1/models 发现请求作为接入前提，也不以模型列表慢或重定向推断模型不可用。'),
    handling: automaticFix(
      '服务商合同使用显式默认模型和真实请求验收，不开启依赖 /v1/models 的网关模型发现。',
      ['provider-route-probe', 'native-route-runner']
    ),
    safetyBoundaryReason: '模型发现可能额外耗时、重定向或暴露不完整列表，不能代替客户实际所选模型的调用。'
  },
  {
    id: 27,
    title: '企业 CA 或自签证书导致 CLI TLS 失败',
    detection: userAction('客户或管理员根据真实原生 CLI 的 TLS 错误确认企业证书链；工具箱不读取证书文件或系统信任库。'),
    handling: doNotDo('不自动设置 NODE_EXTRA_CA_CERTS、不导入 CA，也不降低 TLS 校验；客户按组织安全流程配置证书。'),
    safetyBoundaryReason: '注入自签 CA 或关闭校验会扩大受信任根并影响所有 Node 请求，必须由证书管理员决定。'
  }
] as const satisfies readonly EnvironmentChecklistItem[]

/** Returns a fixed checklist entry without guessing a customer's state. */
export function environmentChecklistItem(id: number): EnvironmentChecklistItem | undefined {
  return environmentChecklist.find(item => item.id === id)
}
