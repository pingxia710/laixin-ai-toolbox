import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { buildReportBody, seal } from '../../app/main/diagnostics/report-bundle'
import { collectLocalFiles, daemonLogCandidates, nodeReportFiles } from '../../app/main/diagnostics/report-collect'
import { credentialFindings } from '../../app/main/diagnostics/report-redact'
import { makeTempDir, removeTempDir } from '../tunnel/helpers'
import type { SupportDiagnosis } from '../../app/main/diagnostics/support-snapshot'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

/** 造一台「真机」：state.json 里带着真令牌，账本里带着系统设置原值，守护日志里带着入口地址。 */
function machine(options: { withLog?: boolean } = {}) {
  const root = makeTempDir('report-bundle-')
  roots.push(root)
  const userDataPath = join(root, 'userData')
  const tunnelDataDir = join(userDataPath, 'tunnel')
  mkdirSync(tunnelDataDir, { recursive: true })
  const secrets = {
    sessionToken: `sess-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    intentToken: randomBytes(32).toString('base64url'),
    uuid: '3f4a1c2e-9b8d-4e7f-a1b2-c3d4e5f60718',
    publicKey: randomBytes(32).toString('base64url'),
    shortId: 'a1b2c3d4',
    apiKey: `sk-ant-api03-${randomBytes(24).toString('base64url')}`
  }
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({
    state: 'connected', runId: 'run-7', sessionToken: secrets.sessionToken, intentToken: secrets.intentToken,
    bridgePort: 18_081, exitIp: '203.0.113.7', lastVerifiedAt: 1_757_000_000_000, code: 'TUNNEL_CONNECTED', message: '已连接',
    reusedProxy: { kind: 'http', host: '127.0.0.1', port: 7890, source: 'system' }, updatedAt: 1_757_000_000_500
  }))
  writeFileSync(join(tunnelDataDir, 'ledger.json'), JSON.stringify([
    { id: `w-${secrets.sessionToken}-1`, kind: 'setting', service: 'Wi-Fi', item: 'webproxy',
      originalValue: { enabled: false, host: '', port: 0 }, writtenValue: { enabled: true, host: '127.0.0.1', port: 18_081 },
      sessionToken: secrets.sessionToken, time: 1_757_000_000_000, status: 'applied', note: '' },
    { id: `w-${secrets.sessionToken}-2`, kind: 'intent', service: 'Intent', item: 'desired',
      originalValue: 'idle', writtenValue: 'connected', sessionToken: secrets.sessionToken, time: 1_757_000_000_100, status: 'restored', note: '' }
  ]))
  writeFileSync(join(tunnelDataDir, 'connection-verified.json'), JSON.stringify({ verifiedAt: 1_757_000_000_400 }))
  if (options.withLog !== false) {
    mkdirSync(join(userDataPath, 'logs'), { recursive: true })
    writeFileSync(join(userDataPath, 'logs', 'tunnel-daemon.log'), [
      '这一行会被当成截断处丢掉',
      `[tunnel-daemon] 换下一条入口重试：vless://${secrets.uuid}@node.example.com:443?pbk=${secrets.publicKey}&sid=${secrets.shortId}`,
      '[tunnel-daemon] 客户请求在通道里连续失败:立即复验',
      `[tunnel-daemon] 模型 Key ${secrets.apiKey} 被上游拒绝`,
      '[tunnel-daemon] 本机中继不在监听:已先把系统代理还给客户,继续后台重连'
    ].join('\n'))
  }
  return { root, userDataPath, tunnelDataDir, secrets }
}

it('打出来的包里没有任何凭据：state.json 的令牌、VLESS 三件、模型 Key 全都进不去', async () => {
  const { userDataPath, tunnelDataDir, secrets } = machine()
  const files = await collectLocalFiles({ userDataPath, tunnelDataDir, files: nodeReportFiles })
  const body = buildReportBody({
    tunnel: { state: '已连', exitIp: '203.0.113.7', nodeLabel: '洛杉矶 A', authorization: '授权:本地包载明' },
    daemonState: files.daemonState, ledger: files.ledger, connection: files.connection, daemonLog: files.daemonLog,
    errorCodes: ['AI_DIAG_TUNNEL_UNREACHABLE', 'TUNNEL_CONNECTED'], notes: files.notes
  })
  // 先证明「凭据真的摆在采集得到的地方」——否则下面那串 not.toContain 会真空通过：
  // 夹具写错路径、采集静默返回空，都会让「包里没有凭据」显得成立，而它什么也没证明。
  const rawInput = JSON.stringify([files.daemonState, files.ledger, files.daemonLog])
  for (const [name, value] of Object.entries(secrets)) {
    if (name === 'shortId') continue // 只出现在日志行里，下面单独核
    expect(rawInput, `夹具没把 ${name} 放进采集得到的输入，本条用例等于没测`).toContain(value)
  }
  expect(rawInput).toContain(secrets.shortId)

  const serialized = JSON.stringify(body)
  for (const [name, value] of Object.entries(secrets)) {
    expect(serialized, `${name} 出现在上报包里`).not.toContain(value)
  }
  // 最后一道闸也要证明是干净的：整包扫不出凭据形状。
  expect(credentialFindings(serialized)).toHaveLength(0)
  // 客服真正要看的东西还在
  expect(serialized).toContain('AI_DIAG_TUNNEL_UNREACHABLE')
  expect(serialized).toContain('203.0.113.7')
  expect(body.daemonLog).toMatchObject({ available: true })
})

it('账本只出类别/项目/状态/时刻，⛔ 原值内容', async () => {
  const { userDataPath, tunnelDataDir } = machine()
  const files = await collectLocalFiles({ userDataPath, tunnelDataDir, files: nodeReportFiles })
  const body = buildReportBody({ ledger: files.ledger, notes: files.notes })
  const ledger = body.ledger as { total: number; byStatus: Record<string, number>; entries: Record<string, unknown>[] }
  expect(ledger.total).toBe(2)
  expect(ledger.byStatus).toEqual({ applied: 1, restored: 1 })
  expect(ledger.entries[0]).toEqual({ kind: 'intent', service: 'Intent', item: 'desired', status: 'restored', time: 1_757_000_000_100, note: '' })
  const serialized = JSON.stringify(body.ledger)
  // item 是设置项名（webproxy），它是客服要看的；⛔ 的是原值与写入值本身。
  for (const forbidden of ['originalValue', 'writtenValue', 'sessionToken', '18081', '"enabled"']) {
    expect(serialized).not.toContain(forbidden)
  }
})

it('守护日志没生成时如实写「未生成」，⛔ 悄悄少一段', async () => {
  const { userDataPath, tunnelDataDir } = machine({ withLog: false })
  const files = await collectLocalFiles({ userDataPath, tunnelDataDir, files: nodeReportFiles })
  const body = buildReportBody({ daemonLog: files.daemonLog, daemonLogAbsence: files.daemonLogAbsence, notes: files.notes })
  expect(body.daemonLog).toMatchObject({ available: false, reason: 'not-generated' })
  expect(JSON.stringify(body.notes)).toContain('守护日志未生成')
  expect(daemonLogCandidates(userDataPath, tunnelDataDir)[0]).toBe(join(userDataPath, 'logs', 'tunnel-daemon.log'))
})

it('文件读不到、内容坏掉都要在包里写明，⛔ 当作一切正常', async () => {
  const root = makeTempDir('report-bundle-missing-')
  roots.push(root)
  const tunnelDataDir = join(root, 'tunnel')
  mkdirSync(tunnelDataDir, { recursive: true })
  writeFileSync(join(tunnelDataDir, 'state.json'), '{ 半截')
  const files = await collectLocalFiles({ userDataPath: root, tunnelDataDir, files: nodeReportFiles })
  const notes = JSON.stringify(buildReportBody({ ...files, notes: files.notes }).notes)
  expect(notes).toContain('state.json 内容不是合法 JSON')
  expect(notes).toContain('ledger.json 不存在')
})

it('超过上限先裁日志再裁账本，裁了要说一句', () => {
  const lines = Array.from({ length: 3_000 }, (_, index) => `[tunnel-daemon] 第 ${String(index)} 行 ${'通道复验超时后重连'.repeat(60)}`)
  const body = buildReportBody({ daemonLog: { source: '/tmp/tunnel-daemon.log', lines } })
  expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(256 * 1024)
  expect(JSON.stringify(body.notes)).toContain('守护日志过长')
})

it('第二道闸：上游多塞了没在白名单里的字段，取值形状照样拦住', () => {
  const leaked = randomBytes(32).toString('base64url')
  // connection 段不走字段白名单（谁都可能往里加字段），正是第二道闸该兜住的地方。
  const body = buildReportBody({ connection: { verifiedAt: 1, 伪装字段: `节点公钥 ${leaked}` } })
  expect(JSON.stringify(body)).not.toContain(leaked)
})

it('第三道闸：前两道都被绕过时，整包复扫仍然抹掉并计数', () => {
  const leaked = randomBytes(32).toString('base64url')
  // 直接喂给 seal——模拟「某天有人加了段不过清洗的内容」。
  const { body, filtered } = seal({ 某段: { 节点: `pbk=${leaked}` } })
  expect(JSON.stringify(body)).not.toContain(leaked)
  expect(filtered).toBe(1)
})

it('系统代理读数真的进包了，地址里的账号密码被抹掉', () => {
  // 这一段的形状是 { resolved, env }，⛔ 套用「一层字段白名单」——那会把整段读数丢掉，
  // 客服就看不到「客户这台机器当时代理指向哪」。
  const body = buildReportBody({ systemProxy: {
    resolved: { 来信后台: 'PROXY 127.0.0.1:18081', 外网站点: 'DIRECT' },
    env: { HTTPS_PROXY: 'http://someone:Sup3r-Secret-Passphrase@proxy.corp.example:8080', NO_PROXY: 'localhost,127.0.0.1' }
  } })
  const serialized = JSON.stringify(body.systemProxy)
  expect(serialized).toContain('PROXY 127.0.0.1:18081')
  expect(serialized).toContain('localhost,127.0.0.1')
  expect(serialized).not.toContain('Sup3r-Secret-Passphrase')
  expect(serialized).not.toContain('someone:')
})

it('组件缺失的完整清单要原样进包——那是客服判「客户这台机器缺了什么」的唯一依据', () => {
  // 主线 1812f14 把给客户看的那句话改成「怎么办」，完整清单只留在 status.componentMissing（上限 400）
  // 与诊断里。上报包取的就是这一份完整清单：⛔ 被截断、⛔ 被形状闸误伤。
  const full = ['tunnel-daemon.mjs', 'adapter-networksetup.mjs', 'connectors.mjs', 'daemon-core.mjs', 'instance-lock.mjs',
    'ledger.mjs', 'managed-adapter.mjs', 'power-events.mjs', 'resident-integrity.mjs', 'restore.mjs', 'routes.default.json',
    'local-bridge.mjs', 'xray-runner.mjs', 'vless-connector.mjs', 'vless-settings.mjs', 'socks5.mjs',
    'xray', 'geoip.dat', 'geosite.dat'].join('、')
  const body = buildReportBody({ tunnel: { state: '未连', componentMissing: full } })
  const carried = (body.network as { status: Record<string, unknown> }).status.componentMissing
  expect(carried).toBe(full)
  expect(String(carried).split('、')).toHaveLength(19)
})

it('上报包携带同一次结构化诊断，补充读数另记采集时间，额外敏感字段进不去', () => {
  const diagnosis = {
    id: 'DG-ABC123',
    report: {
      software: 'hermes', checkedAt: 1_800_000_000_000, validUntil: 1_800_000_600_000,
      target: { label: 'DeepSeek API', route: 'direct' },
      conclusion: {
        status: 'clear', scope: 'none', ruleId: 'DG01_NO_BLOCKER_FOUND', title: '本次未发现明确阻断',
        summary: '目标本次有响应。', nextStep: '回到 Hermes 重试原操作。',
        evidence: [{ checkId: 'service', code: 'AI_DIAG_SERVICE_REACHABLE', statement: '目标有响应。' }],
        leakedKey: 'sk-ant-api03-THIS-MUST-NOT-LEAVE-THE-MACHINE'
      },
      checks: [
        { id: 'internet', label: '基础网络', state: 'passed', code: 'AI_DIAG_INTERNET_OK', message: '基础网络可用。' },
        { id: 'tunnel', label: '通道出口', state: 'not-checked', code: 'AI_DIAG_DIRECT_SERVICE', message: '不需要通道。' },
        { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '目标有响应。' },
        { id: 'account', label: '登录与额度', state: 'not-checked', code: 'AI_DIAG_ACCOUNT_PROVIDER', message: '未验证账号。' },
        { id: 'application', label: '应用接入', state: 'passed', code: 'AI_DIAG_APPLICATION_OBSERVED', message: '观察到调用。' }
      ]
    },
    attempts: [{ at: '2027-01-15T08:00:01.000Z', software: 'Hermes', action: '重新测试', outcome: '已恢复', detail: '复验通过', token: 'secret-fixture-token-value' }],
    attemptsComplete: true
  } as unknown as SupportDiagnosis
  const body = buildReportBody({ diagnosis, supplementalCollectedAt: '2027-01-15T08:00:05.000Z' })
  expect(body.diagnosis).toMatchObject({ id: 'DG-ABC123', software: 'hermes', checkedAt: 1_800_000_000_000,
    target: { label: 'DeepSeek API', route: 'direct' }, conclusion: { ruleId: 'DG01_NO_BLOCKER_FOUND' } })
  expect(body.supplemental).toEqual({ collectedAt: '2027-01-15T08:00:05.000Z' })
  const serialized = JSON.stringify(body)
  expect(serialized).toContain('重新测试')
  expect(serialized).not.toContain('THIS-MUST-NOT-LEAVE')
  expect(serialized).not.toContain('secret-fixture-token-value')
})

it('「日志读不出来」⛔ 说成「日志没生成」——后者会让客服以为这台机器一切正常', async () => {
  const { userDataPath, tunnelDataDir } = machine({ withLog: false })
  // 文件在、但打不开（权限、磁盘坏道、被别的进程独占）。
  const files = await collectLocalFiles({ userDataPath, tunnelDataDir, files: {
    readText: nodeReportFiles.readText,
    readTail: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
  } })
  expect(files.daemonLogAbsence).toBe('unreadable')
  const body = buildReportBody({ daemonLog: files.daemonLog, daemonLogAbsence: files.daemonLogAbsence, notes: files.notes })
  expect(body.daemonLog).toMatchObject({ available: false, reason: 'unreadable' })
  expect(JSON.stringify(body.daemonLog)).toContain('读不出来')
  expect(JSON.stringify(body.daemonLog)).not.toContain('未生成')
  expect(JSON.stringify(body.notes)).toContain('守护日志读取失败：EACCES')
  // 「没生成」那句 ⛔ 同时出现：两种状态说成一种，客服就分不出这台机器另有毛病。
  expect(JSON.stringify(body.notes)).not.toContain('守护日志未生成')
})
