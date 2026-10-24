import { describe, expect, it } from 'vitest'
import {
  activeRewriteRules, builtinRewriteRules, parseRewritePath, protocolForShell,
  rewriteUpstreamRequest, validateRewriteRules, type RewriteRule
} from '../../app/main/ai-access/provider-rewrite'

/** Hermes 起会话标题的真实请求形状（2026-09-13 抓到的那条固定 400）。 */
function hermesTitleBody() {
  return {
    messages: [
      { role: 'system', content: 'Summarise the conversation into a short title.' },
      { role: 'user', content: 'hello there' }
    ],
    max_tokens: 40,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'title', strict: true, schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }
    }
  }
}

/** 带工具调用的第二轮请求：assistant 消息有 tool_calls 但没有 reasoning_content。 */
function toolTurnBody() {
  return {
    messages: [
      { role: 'user', content: 'run the tool' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'OK' }
    ],
    tools: [{ type: 'function', function: { name: 'noop', description: 'no-op', parameters: { type: 'object', properties: {} } } }],
    max_tokens: 8
  }
}

function run(overrides: Partial<Parameters<typeof rewriteUpstreamRequest>[0]> = {}, rules?: readonly RewriteRule[]) {
  return rewriteUpstreamRequest({
    shell: 'hermes', provider: 'deepseek', model: 'deepseek-flash',
    body: hermesTitleBody(), headers: { 'content-type': 'application/json' },
    ...overrides
  }, rules)
}

describe('网关按供应商改写请求', () => {
  it('壳决定协议，⛔ 由请求体猜', () => {
    expect(protocolForShell).toEqual({ codex: 'responses', claude: 'messages', hermes: 'chat' })
  })

  it('内置规则本身通得过校验（配方下发的是同一形状）', () => {
    expect(validateRewriteRules(structuredClone(builtinRewriteRules) as unknown)).toBe(true)
  })

  describe('R1 · DeepSeek chat 的 json_schema', () => {
    it('降级成 json_object，并因为提示里已经没有 json 字样而补上一句', () => {
      const result = run()
      expect(result.body.response_format).toEqual({ type: 'json_object' })
      const messages = result.body.messages as { role: string; content: string }[]
      expect(messages[0]?.content).toBe('Summarise the conversation into a short title.\n\nRespond in JSON.')
      expect(messages[1]?.content).toBe('hello there')
      expect(result.applied).toEqual(['deepseek.chat.json-schema-to-json-object', 'deepseek.chat.json-hint-system', 'deepseek.chat.json-object-disable-thinking'])
    })

    it('提示里本来就有 json 字样时只降级，⛔ 再加一句', () => {
      const body = hermesTitleBody()
      body.messages[0] = { role: 'system', content: 'Return JSON {"title":string}.' }
      const result = run({ body })
      expect(result.body.response_format).toEqual({ type: 'json_object' })
      expect((result.body.messages as { content: string }[])[0]?.content).toBe('Return JSON {"title":string}.')
      expect(result.applied).toEqual(['deepseek.chat.json-schema-to-json-object', 'deepseek.chat.json-object-disable-thinking'])
    })

    it('分块内容（content 是数组）追加到最后一块文字上', () => {
      const body = { ...hermesTitleBody(), messages: [{ role: 'system', content: [{ type: 'text', text: 'Be terse.' }] }, { role: 'user', content: 'hi' }] }
      const result = run({ body })
      expect(result.body.messages).toEqual([
        { role: 'system', content: [{ type: 'text', text: 'Be terse.\n\nRespond in JSON.' }] },
        { role: 'user', content: 'hi' }
      ])
      expect(result.body.thinking).toEqual({ type: 'disabled' })
    })

    it('没有 system 消息时退到最后一条消息，⛔ 两处都加', () => {
      const body = { ...hermesTitleBody(), messages: [{ role: 'user', content: 'make me a title' }] }
      const result = run({ body })
      expect(result.body.messages).toEqual([{ role: 'user', content: 'make me a title\n\nRespond in JSON.' }])
      expect(result.applied).toEqual(['deepseek.chat.json-schema-to-json-object', 'deepseek.chat.json-hint-fallback', 'deepseek.chat.json-object-disable-thinking'])
    })

    it('本来就发 json_object 也补提示（DeepSeek 的 JSON 模式一样要求提示里出现 json）', () => {
      const body = { ...hermesTitleBody(), response_format: { type: 'json_object' } }
      const result = run({ body })
      expect(result.applied).toEqual(['deepseek.chat.json-hint-system', 'deepseek.chat.json-object-disable-thinking'])
    })

    it('反例：json_schema 但不是 chat 协议（Claude Code 走 messages），⛔ 动', () => {
      const result = run({ shell: 'claude' })
      expect(result.body.response_format).toEqual(hermesTitleBody().response_format)
      expect(result.applied).toEqual([])
    })
  })

  describe('R3 · json_object 下关掉思考', () => {
    it('降级后顺手关思考（DeepSeek 的思考模型会把 max_tokens 全花在思考上，标题就空了）', () => {
      const result = run()
      expect(result.body.thinking).toEqual({ type: 'disabled' })
    })

    it('客户端自己显式传了 thinking 就 ⛔ 动', () => {
      const body = { ...hermesTitleBody(), thinking: { type: 'enabled', budget_tokens: 512 } }
      const result = run({ body })
      expect(result.body.thinking).toEqual({ type: 'enabled', budget_tokens: 512 })
      expect(result.applied).not.toContain('deepseek.chat.json-object-disable-thinking')
    })

    it('反例：不是 json_object 的普通请求 ⛔ 关思考', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }
      const result = run({ body })
      expect(result.body).toBe(body)
    })

    it('末块不是 text 的分块内容：提示补不上去（跳过），但思考照样关', () => {
      const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }], response_format: { type: 'json_object' } }
      const result = run({ body })
      expect(result.applied).toEqual(['deepseek.chat.json-object-disable-thinking'])
      expect(result.body.messages).toEqual(body.messages)
      expect(result.body.thinking).toEqual({ type: 'disabled' })
    })
  })

  it('幂等：改写过的请求体再过一遍规则，一处都不动', () => {
    const first = run({ body: { ...hermesTitleBody(), messages: [...hermesTitleBody().messages, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }] } })
    expect(first.applied).toHaveLength(4)
    const second = run({ body: first.body })
    expect(second.body).toBe(first.body)
    expect(second.applied).toEqual([])
  })

  describe('原型污染', () => {
    // 配方要签名，但**签名管的是来源、不是内容**——一份被写坏的配方 ⛔ 能改掉运行时。
    const evil = ['__proto__.polluted', 'constructor.prototype.polluted', 'messages[].__proto__.polluted',
      'a.prototype.polluted', 'messages[__proto__=x].polluted', 'messages[constructor].polluted']

    it('这些路径解析、校验、执行三道都不认', () => {
      for (const path of evil) {
        expect(parseRewritePath(path), path).toBeNull()
        const rules = [{ id: 'evil', provider: '*', protocol: '*', ops: [{ op: 'set', path, value: 'x' }] }]
        expect(validateRewriteRules(rules), path).toBe(false)
        const body = { messages: [{ role: 'user', content: 'hi' }] }
        const result = rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'x', body, headers: {} }, rules as unknown as RewriteRule[])
        expect(result.body, path).toBe(body)
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(Object.prototype).not.toHaveProperty('polluted')
    })

    it('rename 的目标、请求头名、字面量值的键名也不认', () => {
      const cases: unknown[] = [
        [{ id: 'a', provider: '*', protocol: '*', ops: [{ op: 'rename', path: 'a', to: '__proto__' }] }],
        [{ id: 'a', provider: '*', protocol: '*', ops: [{ op: 'rename', path: 'a', to: 'constructor' }] }],
        [{ id: 'a', provider: '*', protocol: '*', ops: [{ op: 'delete', target: 'headers', path: 'constructor' }] }],
        // 配方是 JSON.parse 出来的，`"__proto__"` 在那边是**自有属性**（写成 TS 对象字面量反而会去设原型）。
        JSON.parse('[{"id":"a","provider":"*","protocol":"*","ops":[{"op":"set","path":"a","value":{"__proto__":{"polluted":1}}}]}]'),
        JSON.parse('[{"id":"a","provider":"*","protocol":"*","ops":[{"op":"set","path":"a","value":{"nested":{"constructor":1}}}]}]')
      ]
      for (const rules of cases) expect(validateRewriteRules(rules), JSON.stringify(rules)).toBe(false)
    })

    it('取值只认自有属性：`toString` 这种原型链上的东西 ⛔ 算「存在」', () => {
      const rules: RewriteRule[] = [{ id: 'x.proto-exists', provider: '*', protocol: '*', when: { exists: ['toString'] }, ops: [{ op: 'set', path: 'marked', value: 1 }] }]
      const body = { messages: [] }
      expect(rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'x', body, headers: {} }, rules).body).toBe(body)
    })
  })

  describe('R2 · assistant 带 tool_calls 缺 reasoning_content', () => {
    it('只给带 tool_calls 的 assistant 消息补 ""', () => {
      const result = run({ body: toolTurnBody() })
      const messages = result.body.messages as Record<string, unknown>[]
      expect(messages[1]?.reasoning_content).toBe('')
      expect(messages[0]).toEqual({ role: 'user', content: 'run the tool' })
      expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'OK' })
      expect(result.applied).toEqual(['deepseek.chat.assistant-tool-calls-reasoning-content'])
    })

    it('已经带了 reasoning_content 就原样不动', () => {
      const body = toolTurnBody()
      body.messages[1] = { ...body.messages[1], reasoning_content: '想了想' } as unknown as typeof body.messages[1]
      const result = run({ body })
      expect(result.body).toBe(body)
      expect(result.applied).toEqual([])
    })

    it('reasoning_content 是 null 也补（DeepSeek 报的就是这个字段没回传）', () => {
      const body = toolTurnBody()
      body.messages[1] = { ...body.messages[1], reasoning_content: null } as unknown as typeof body.messages[1]
      const result = run({ body })
      expect((result.body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe('')
    })

    it('反例：assistant 消息没有 tool_calls，⛔ 加字段', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '你好' }], max_tokens: 8 }
      const result = run({ body })
      expect(result.body).toBe(body)
    })
  })

  describe('未命中', () => {
    it('返回传进来的同一个对象引用，⛔ 复制（网关热路径）', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }
      const headers = { 'content-type': 'application/json' }
      const result = rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'deepseek-flash', body, headers })
      expect(result.body).toBe(body)
      expect(result.headers).toBe(headers)
      expect(result.applied).toEqual([])
    })

    it('命中时不动原对象（复制一份改）', () => {
      const body = hermesTitleBody()
      const result = run({ body })
      expect(result.body).not.toBe(body)
      expect(body.response_format.type).toBe('json_schema')
      expect(body.messages[0]?.content).toBe('Summarise the conversation into a short title.')
    })

    it('智谱、Kimi 的同样请求逐字节不变（今天实测三协议全通，⛔ 误伤）', () => {
      for (const provider of ['zhipu', 'kimi', 'moonshot']) {
        for (const shell of ['codex', 'claude', 'hermes'] as const) {
          const body = shell === 'hermes' ? hermesTitleBody() : shell === 'codex'
            ? { input: [{ role: 'user', content: 'hi' }], max_output_tokens: 16, tools: [{ type: 'web_search' }] }
            : { messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, thinking: { type: 'enabled', budget_tokens: 32 } }
          const headers = { 'content-type': 'application/json', 'anthropic-beta': 'context-management-2026-06-27' }
          const result = rewriteUpstreamRequest({ shell, provider, model: 'glm-5.3-flash', body, headers })
          expect(result.body).toBe(body)
          expect(result.headers).toBe(headers)
          expect(result.applied).toEqual([])
        }
      }
    })

    it('DeepSeek 的三种协议 baseline 也不变', () => {
      const cases = [
        { shell: 'hermes' as const, body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 } },
        { shell: 'claude' as const, body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, top_k: 5 } },
        { shell: 'codex' as const, body: { input: [{ role: 'user', content: 'hi' }], max_output_tokens: 16 } }
      ]
      for (const { shell, body } of cases) {
        const result = rewriteUpstreamRequest({ shell, provider: 'deepseek', model: 'deepseek-flash', body, headers: {} })
        expect(result.body).toBe(body)
      }
    })
  })

  describe('请求头改写（今天没有内置规则，机制要能用）', () => {
    const strip: RewriteRule = { id: 'x.strip-beta', provider: 'deepseek', protocol: 'messages', ops: [{ op: 'delete', target: 'headers', path: 'anthropic-beta' }] }

    it('删头：按大小写不敏感找到实际那个键', () => {
      const headers = { 'content-type': 'application/json', 'Anthropic-Beta': 'interleaved-thinking-2026-05-14' }
      const result = rewriteUpstreamRequest({ shell: 'claude', provider: 'deepseek', model: 'deepseek-flash', body: { messages: [] }, headers }, [strip])
      expect(result.headers).toEqual({ 'content-type': 'application/json' })
      expect(headers['Anthropic-Beta']).toBe('interleaved-thinking-2026-05-14')
      expect(result.applied).toEqual(['x.strip-beta'])
    })

    it('头不存在时不算命中，返回原引用', () => {
      const headers = { 'content-type': 'application/json' }
      const result = rewriteUpstreamRequest({ shell: 'claude', provider: 'deepseek', model: 'deepseek-flash', body: { messages: [] }, headers }, [strip])
      expect(result.headers).toBe(headers)
      expect(result.applied).toEqual([])
    })

    it('set / default / rename 都走得通', () => {
      const rules: RewriteRule[] = [
        { id: 'x.set', provider: '*', protocol: '*', ops: [{ op: 'set', target: 'headers', path: 'anthropic-version', value: '2023-06-01' }] },
        { id: 'x.default', provider: '*', protocol: '*', ops: [{ op: 'default', target: 'headers', path: 'user-agent', value: 'Laixin' }] },
        { id: 'x.rename', provider: '*', protocol: '*', ops: [{ op: 'rename', target: 'headers', path: 'x-old', to: 'x-new' }] }
      ]
      const result = rewriteUpstreamRequest({ shell: 'claude', provider: 'zhipu', model: 'glm-5.3-flash', body: {}, headers: { 'user-agent': 'Codex', 'x-old': '1' } }, rules)
      expect(result.headers).toEqual({ 'anthropic-version': '2023-06-01', 'user-agent': 'Codex', 'x-new': '1' })
      expect(result.applied).toEqual(['x.set', 'x.rename'])
    })

    it('⛔ 动鉴权头，即便规则这么写', () => {
      const rules: RewriteRule[] = [{ id: 'x.bad', provider: '*', protocol: '*', ops: [{ op: 'set', target: 'headers', path: 'authorization', value: 'Bearer stolen' }] }]
      const headers = { authorization: 'Bearer real' }
      const result = rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'x', body: {}, headers }, rules)
      expect(result.headers).toBe(headers)
      expect(validateRewriteRules(rules)).toBe(false)
    })
  })

  it('⛔ 动 model，即便规则这么写', () => {
    const rules: RewriteRule[] = [{ id: 'x.model', provider: '*', protocol: '*', ops: [{ op: 'set', path: 'model', value: 'somebody-elses-model' }] }]
    const body = { model: 'deepseek-flash', messages: [] }
    const result = rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'deepseek-flash', body, headers: {} }, rules)
    expect(result.body).toBe(body)
    expect(validateRewriteRules(rules)).toBe(false)
  })

  describe('activeRewriteRules · 配方覆盖内置', () => {
    it('没有配方规则时就是内置那一份（同一引用）', () => {
      expect(activeRewriteRules()).toBe(builtinRewriteRules)
      expect(activeRewriteRules([])).toBe(builtinRewriteRules)
    })

    it('同 id 的配方规则替换内置那条，其余内置照常在后面', () => {
      const override: RewriteRule = {
        id: 'deepseek.chat.json-schema-to-json-object', provider: 'deepseek', protocol: 'chat',
        when: { equals: [['response_format.type', 'json_schema']] },
        ops: [{ op: 'delete', path: 'response_format' }]
      }
      const rules = activeRewriteRules([override])
      expect(rules[0]).toBe(override)
      expect(rules).toHaveLength(builtinRewriteRules.length)
      const result = run({}, rules)
      expect(result.body.response_format).toBeUndefined()
      expect(result.body.thinking).toBeUndefined()
      // 内置的 R2 还在：换个请求体照样命中。
      expect(rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'deepseek-flash', body: toolTurnBody(), headers: {} }, rules).applied)
        .toEqual(['deepseek.chat.assistant-tool-calls-reasoning-content'])
    })

    it('配方能加一条内置没有的新规则（厂商行为变了就靠这条下发，客户端不用升级）', () => {
      const fresh: RewriteRule = {
        id: 'zhipu.chat.drop-top-k', provider: 'zhipu', protocol: 'chat', models: ['glm-5.3-flash'],
        ops: [{ op: 'delete', path: 'top_k' }]
      }
      const rules = activeRewriteRules([fresh])
      expect(rules).toHaveLength(builtinRewriteRules.length + 1)
      const hit = rewriteUpstreamRequest({ shell: 'hermes', provider: 'zhipu', model: 'glm-5.3-flash', body: { messages: [], top_k: 5 }, headers: {} }, rules)
      expect(hit.body).toEqual({ messages: [] })
      // 限定了模型，别的模型不受影响。
      const miss = rewriteUpstreamRequest({ shell: 'hermes', provider: 'zhipu', model: 'glm-5.3', body: { messages: [], top_k: 5 }, headers: {} }, rules)
      expect(miss.applied).toEqual([])
    })
  })

  describe('路径语法', () => {
    it('认得数组每项、下标、字段等值、字段存在', () => {
      expect(parseRewritePath('messages[].reasoning_content')).toBeTruthy()
      expect(parseRewritePath('messages[role=system][0].content')).toBeTruthy()
      expect(parseRewritePath('messages[-1].content')).toBeTruthy()
      expect(parseRewritePath('messages[role=assistant][tool_calls].reasoning_content')).toBeTruthy()
    })

    it('末段带选择器、非法字符、超长、空段一律不认', () => {
      for (const bad of ['messages[]', 'messages[0]', 'a..b', '', '.a', 'a.b[', 'a[b=c', 'a[$]', 'messages[role=sys"tem].c', 'a'.repeat(201), 'a.b.c.d.e.f.g.h.i.j.k.l.m']) {
        expect(parseRewritePath(bad), bad).toBeNull()
      }
    })

    it('解不到的路径就是不命中，⛔ 抛错', () => {
      const rules: RewriteRule[] = [{ id: 'x.deep', provider: '*', protocol: '*', ops: [{ op: 'set', path: 'a.b.c.d', value: 1 }] }]
      const body = { messages: [] }
      expect(rewriteUpstreamRequest({ shell: 'hermes', provider: 'deepseek', model: 'x', body, headers: {} }, rules).body).toBe(body)
    })
  })

  describe('validateRewriteRules', () => {
    const ok = (extra: Record<string, unknown> = {}): unknown => [{ id: 'a.b', provider: 'deepseek', protocol: 'chat', ops: [{ op: 'delete', path: 'top_k' }], ...extra }]

    it('接受合法的一份', () => {
      expect(validateRewriteRules(ok())).toBe(true)
      expect(validateRewriteRules([])).toBe(true)
      expect(validateRewriteRules(ok({ when: { exists: ['a'], missing: ['b'], equals: [['a.b', 1]], noneContains: [['messages[].content', 'json']] }, models: ['deepseek-flash'] }))).toBe(true)
    })

    it('拒绝非数组、超长、重复 id', () => {
      expect(validateRewriteRules({})).toBe(false)
      expect(validateRewriteRules(null)).toBe(false)
      expect(validateRewriteRules(Array.from({ length: 201 }, (_, i) => ({ id: `a${i}`, provider: '*', protocol: '*', ops: [{ op: 'delete', path: 'x' }] })))).toBe(false)
      expect(validateRewriteRules([...(ok() as unknown[]), ...(ok() as unknown[])])).toBe(false)
    })

    it('拒绝非法 id / provider / protocol / models', () => {
      expect(validateRewriteRules(ok({ id: 'A.B' }))).toBe(false)
      expect(validateRewriteRules(ok({ id: '' }))).toBe(false)
      expect(validateRewriteRules(ok({ provider: 'Dee pSeek' }))).toBe(false)
      expect(validateRewriteRules(ok({ protocol: 'grpc' }))).toBe(false)
      expect(validateRewriteRules(ok({ models: [] }))).toBe(false)
      expect(validateRewriteRules(ok({ models: ['bad model'] }))).toBe(false)
    })

    it('拒绝未知 op、未知字段、缺参数、参数类型不对', () => {
      expect(validateRewriteRules(ok({ ops: [{ op: 'exec', path: 'a' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'set', path: 'a', value: 1, extra: 2 }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'rename', path: 'a' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'rename', path: 'a', to: 'b.c' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'append', path: 'a', value: 1 }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'delete', path: 'a', value: 1 }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: Array.from({ length: 21 }, () => ({ op: 'delete', path: 'x' })) }))).toBe(false)
      expect(validateRewriteRules(ok({ extra: 1 }))).toBe(false)
    })

    it('拒绝非法路径与受保护的路径', () => {
      expect(validateRewriteRules(ok({ ops: [{ op: 'delete', path: 'messages[]' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'delete', path: 'model' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'rename', path: 'a', to: 'model' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'delete', target: 'headers', path: 'x-api-key' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'delete', target: 'headers', path: 'Anthropic-Beta' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'delete', target: 'both', path: 'a' }] }))).toBe(false)
      expect(validateRewriteRules(ok({ when: { exists: ['messages[]'] } }))).toBe(false)
      expect(validateRewriteRules(ok({ when: { unknown: ['a'] } }))).toBe(false)
      expect(validateRewriteRules(ok({ when: { equals: [['a']] } }))).toBe(false)
      expect(validateRewriteRules(ok({ when: { noneContains: [['a', 1]] } }))).toBe(false)
    })

    it('拒绝超大与不可序列化的值', () => {
      expect(validateRewriteRules(ok({ ops: [{ op: 'set', path: 'a', value: 'x'.repeat(5000) }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'set', path: 'a', value: { n: Number.NaN } }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'set', path: 'a', value: () => 1 }] }))).toBe(false)
      expect(validateRewriteRules(ok({ ops: [{ op: 'set', path: 'a', value: Array.from({ length: 65 }, () => 1) }] }))).toBe(false)
      let deep: unknown = 1
      for (let i = 0; i < 10; i++) deep = { deep }
      expect(validateRewriteRules(ok({ ops: [{ op: 'set', path: 'a', value: deep }] }))).toBe(false)
    })
  })
})
