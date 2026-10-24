import type { Schema } from './schema'
import { matchesSchema, explainMismatch } from './schema'

export class BridgeError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'BridgeError'
    this.code = code
  }
}

export interface ActionDefinition {
  readonly name: string
  readonly paramsSchema: Schema
  readonly resultSchema: Schema
  readonly handler: (params: unknown) => unknown | Promise<unknown>
}

export interface ActionRegistryOptions {
  /** 诊断通道:ACTION_FAILED 时第三个参数带上原始错误(甲-6 本机留证);ACTION_RESULT_INVALID 时第二个参数是「哪个字段怎么不合」。 */
  readonly diagnostic?: (code: string, actionName: string, error?: unknown) => void
  readonly authorize?: (actionName: string) => Promise<void>
}

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition>()
  private readonly diagnostic: (code: string, actionName: string, error?: unknown) => void

  constructor(private readonly options: ActionRegistryOptions = {}) {
    this.diagnostic = options.diagnostic ?? (() => undefined)
  }

  registerAction(action: ActionDefinition): void {
    if (this.actions.has(action.name)) {
      throw new BridgeError('ACTION_ALREADY_REGISTERED')
    }
    this.actions.set(action.name, action)
  }

  async execute(name: string, params: unknown): Promise<unknown> {
    const action = this.actions.get(name)
    if (action === undefined) {
      throw new BridgeError('ACTION_NOT_FOUND')
    }
    if (!matchesSchema(params, action.paramsSchema)) {
      throw new BridgeError('ACTION_PARAMS_INVALID')
    }
    await this.options.authorize?.(name)

    let result: unknown
    try {
      result = await action.handler(params)
    } catch (error) {
      // 甲-6:兜底把原始错误一并交到诊断通道(落进本机故障记录,诊断包收集);
      // 桥上仍只回受控码(⛔ 异常正文进客户可见面,既有用例钉着)。
      this.diagnostic('ACTION_FAILED', action.name, error)
      throw new BridgeError('ACTION_FAILED')
    }

    if (!matchesSchema(result, action.resultSchema)) {
      // 诊断里带上「哪个字段、怎么不合」——⛔ 只丢一个动作名让接手的人靠猜
      // （这条真撞上过：组件清单变长把 status 顶出上限，两个窗口都只能猜是哪个字段）。
      const why = explainMismatch(result, action.resultSchema).slice(0, 5).join('；')
      this.diagnostic('ACTION_RESULT_INVALID', why === '' ? action.name : `${action.name}:${why}`)
      throw new BridgeError('ACTION_RESULT_INVALID')
    }
    return result
  }
}
