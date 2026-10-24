import { describe, expect, it, vi } from 'vitest'
import { createPlanQuotaCache, readPlanQuota, type PlanQuotaResult, type PlanQuotaSource } from '../../app/main/ai-access/plan-usage'

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

/**
 * 2026-09-12 用创始人的真 Key 打回来的**原样响应**（只删了账号相关的无关字段）。
 * 真 Key 之前手写的桩是 `TIME_LIMIT` / `TOKENS_LIMIT`，真实返回的却是文档里没有的 `CREDIT_LIMIT`，
 * 窗口长度也不在 type 里而在 `unit`+`number` 里——这份原样响应就是防这类回退的。
 */
const zhipuBody = {
  code: 200, msg: '操作成功', success: true,
  data: {
    level: 'lite',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2_000, currentValue: 0, remaining: 2_000, percentage: 0 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10_000, currentValue: 1_442, remaining: 8_557, percentage: 14, nextResetTime: 1_789_696_406_979 }
    ]
  }
}

/**
 * 2026-09-12 用创始人本机 Kimi Code 的登录态打回来的**原样响应**（账号标识与钱包 id 已抹）。
 * 与手写桩的两处差别都在这份里：数字是**字符串**形式；5 小时那档**只给 limit 与 remaining、不给 used**。
 */
const kimiBody = {
  user: { membership: { level: 'LEVEL_ADVANCED' } },
  usage: { limit: '100', used: '28', remaining: '72', resetTime: '2026-09-13T06:48:37.910732Z' },
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-09-12T11:48:37.910732Z' } }],
  parallel: { limit: '30' },
  boosterWallet: { balance: { type: 'BOOSTER', amount: 0 }, monthlyChargeLimit: { currency: 'CNY', priceInCents: '10000' } }
}

describe('套餐用量接口', () => {
  it('智谱按 unit+number 给窗口起名，套餐等级写成客户看得懂的形状', async () => {
    const result = await readPlanQuota('zhipu', 'key', (async () => reply(200, zhipuBody)) as unknown as typeof fetch)
    expect(result.status).toBe('plan')
    expect(result.quota?.level).toBe('GLM Coding Lite')
    // ⛔ 把 CREDIT_LIMIT 这种原始枚举名甩到客户屏幕上；两档要分得出谁是 5 小时谁是周。
    expect(result.quota?.windows.map((quota) => quota.name)).toEqual(['5 小时额度', '每周额度'])
    expect(result.quota?.windows[1]).toMatchObject({ usedPercent: 14, remainingPercent: 86, used: 1_442, limit: 10_000 })
    // 真 Key 实测 nextResetTime 本来就是毫秒（13 位），⛔ 再乘 1000。
    expect(result.quota?.windows[1].resetsAt).toBe(1_789_696_406_979)
    expect(result.quota?.windows[0].resetsAt).toBeNull()
  })

  it('没实证过的 unit ⛔ 编窗口名，退回按类型命名并编号', async () => {
    const body = { code: 200, data: { level: 'pro', limits: [
      { type: 'CREDIT_LIMIT', unit: 9, number: 2, percentage: 10 },
      { type: 'CREDIT_LIMIT', unit: 9, number: 3, percentage: 20 },
      { type: 'TIME_LIMIT', percentage: 30 }
    ] } }
    const result = await readPlanQuota('zhipu', 'key', (async () => reply(200, body)) as unknown as typeof fetch)
    expect(result.quota?.windows.map((quota) => quota.name)).toEqual(['额度', '额度 2', '按时长额度'])
  })

  it('Kimi Code 把 300 分钟窗口折成 5 小时，数字是字符串也照收', async () => {
    const result = await readPlanQuota('kimi', 'sk-kimi-test', (async () => reply(200, kimiBody)) as unknown as typeof fetch)
    expect(result.status).toBe('plan')
    expect(result.quota?.level).toBe('Advanced')
    expect(result.quota?.windows.map((quota) => quota.name)).toEqual(['周额度', '5 小时额度'])
    expect(result.quota?.windows[0]).toMatchObject({ used: 28, limit: 100, usedPercent: 28, remainingPercent: 72 })
    expect(result.quota?.windows[0].resetsAt).toBe(Date.parse('2026-09-13T06:48:37.910732Z'))
  })

  it('Kimi 的 5 小时那档不给 used，要由 limit-remaining 算出来，⛔ 报「剩余额度未知」', async () => {
    const result = await readPlanQuota('kimi', 'sk-kimi-test', (async () => reply(200, kimiBody)) as unknown as typeof fetch)
    expect(result.quota?.windows[1]).toMatchObject({ name: '5 小时额度', used: 0, limit: 100, usedPercent: 0, remainingPercent: 100 })
    // 连 remaining 也没有才算真的不知道。
    const blind = { usage: { limit: '10' }, limits: [{ window: { duration: 60, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '10' } }] }
    const unknown = await readPlanQuota('kimi', 'k', (async () => reply(200, blind)) as unknown as typeof fetch)
    expect(unknown.quota?.windows[1]).toMatchObject({ name: '1 小时额度', used: null, usedPercent: null, remainingPercent: null })
  })

  it('没 Key、被拒、连不上、格式不对分别报出来，⛔ 当成额度为 0', async () => {
    expect(await readPlanQuota('kimi', undefined)).toMatchObject({ status: 'key-missing', quota: null })
    expect(await readPlanQuota('kimi', 'k', (async () => reply(401, {})) as unknown as typeof fetch)).toMatchObject({ status: 'key-rejected' })
    expect(await readPlanQuota('kimi', 'k', (async () => reply(500, {})) as unknown as typeof fetch)).toMatchObject({ status: 'invalid-reply' })
    expect(await readPlanQuota('kimi', 'k', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toMatchObject({ status: 'network-error' })
    expect(await readPlanQuota('zhipu', 'k', (async () => reply(200, { data: { limits: 'nope' } })) as unknown as typeof fetch)).toMatchObject({ status: 'invalid-reply' })
  })

  it('智谱把认证失败写在 body 里、HTTP 仍是 200，⛔ 只看状态码把它当成格式看不懂', async () => {
    // 上线检查实测：**API Key 写错时回的是 code 1000**（改末位 / 乱写 32 位 / bad.key 三种都一样）。
    // 交付时按 code 401 写的那份是 ZCode 自己那套 JWT 过期的形状，拿 API Key 复现不出来。
    const badKey = (async () => reply(200, { code: 1000, msg: '身份验证失败。', success: false })) as unknown as typeof fetch
    expect(await readPlanQuota('zhipu', 'bad', badKey)).toMatchObject({ status: 'key-rejected', quota: null })
    const jwtExpired = (async () => reply(200, { code: 401, msg: '令牌已过期或验证不正确', success: false })) as unknown as typeof fetch
    expect(await readPlanQuota('zhipu', 'bad', jwtExpired)).toMatchObject({ status: 'key-rejected', quota: null })
    // 只给中文提示、没给可认的 code 时也要认出来。
    const worded = (async () => reply(200, { code: 9999, msg: '身份验证失败。', success: false })) as unknown as typeof fetch
    expect(await readPlanQuota('zhipu', 'bad', worded)).toMatchObject({ status: 'key-rejected' })
    // 不是认证问题的失败仍然按「看不懂」走，⛔ 一律赖到 Key 头上。
    const other = (async () => reply(200, { code: 500, msg: '服务异常', success: false })) as unknown as typeof fetch
    expect(await readPlanQuota('zhipu', 'k', other)).toMatchObject({ status: 'invalid-reply' })
    // code 正常但 success:false：ZCode 自己也一律当失败。
    const inconsistent = (async () => reply(200, { code: 200, success: false, data: { limits: [] } })) as unknown as typeof fetch
    expect(await readPlanQuota('zhipu', 'k', inconsistent)).toMatchObject({ status: 'invalid-reply' })
  })

  // 网关/风控把响应换成 HTML 页面时，body 解析失败——那是「服务商回了看不懂的东西」，⛔ 报成「连不上服务商」把客户支去查网络。
  it('HTTP 200 但响应体不是 JSON（网关 HTML 页）时报「看不懂」，⛔ 报成连不上', async () => {
    const html = (async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    expect((await readPlanQuota('zhipu', 'key', html)).status).toBe('invalid-reply')
    expect((await readPlanQuota('kimi', 'key', html)).status).toBe('invalid-reply')
  })

  it('智谱裸 token 被拒时补一次 Bearer，认证写法差异 ⛔ 报成 Key 不对', async () => {
    const seen: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const header = String((init.headers as Record<string, string>).Authorization)
      seen.push(header)
      return header.startsWith('Bearer ') ? reply(200, zhipuBody) : reply(200, { code: 401, success: false })
    }) as unknown as typeof fetch
    expect(await readPlanQuota('zhipu', 'key', fetchImpl)).toMatchObject({ status: 'plan' })
    expect(seen).toEqual(['key', 'Bearer key'])
    // Kimi 只有 Bearer 一种写法，⛔ 多打一次服务商。
    const kimiSeen: string[] = []
    const kimiFetch = (async (_url: string, init: RequestInit) => {
      kimiSeen.push(String((init.headers as Record<string, string>).Authorization))
      return reply(401, {})
    }) as unknown as typeof fetch
    expect(await readPlanQuota('kimi', 'k', kimiFetch)).toMatchObject({ status: 'key-rejected' })
    expect(kimiSeen).toEqual(['Bearer k'])
  })
})

describe('用量缓存', () => {
  const result = (source: PlanQuotaSource): PlanQuotaResult => ({ source, quota: { level: null, windows: [] }, status: 'plan' })

  it('同一来源同一 Key 在 60 秒内只打一次服务商，过期后重新读', async () => {
    const read = vi.fn(async (source: PlanQuotaSource) => result(source))
    let now = 1_000
    const cache = createPlanQuotaCache(read, () => now, 60_000)
    await cache.read('zhipu', 'key')
    await cache.read('zhipu', 'key')
    expect(read).toHaveBeenCalledTimes(1)
    now += 60_001
    await cache.read('zhipu', 'key')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('换 Key 或换来源各走各的缓存', async () => {
    const read = vi.fn(async (source: PlanQuotaSource) => result(source))
    const cache = createPlanQuotaCache(read, () => 1_000, 60_000)
    await Promise.all([cache.read('zhipu', 'a'), cache.read('zhipu', 'b'), cache.read('kimi', 'a')])
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('在途的请求被合并，界面重绘再密也只有一次网络调用', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const read = vi.fn(async (source: PlanQuotaSource) => { await gate; return result(source) })
    const cache = createPlanQuotaCache(read, () => 1_000, 60_000)
    const all = Promise.all([cache.read('kimi', 'k'), cache.read('kimi', 'k'), cache.read('kimi', 'k')])
    release()
    expect((await all).map((entry) => entry.status)).toEqual(['plan', 'plan', 'plan'])
    expect(read).toHaveBeenCalledTimes(1)
  })
})
