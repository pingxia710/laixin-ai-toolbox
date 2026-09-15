import type { AiAccessApi } from '../../../preload/api/ai-access'
import type { AiAccessProvider } from '../../../main/ai-access/service'
import { apiFailureMessage, apiFailureRemedy, apiRemedyActions, apiRemedyLabels, type ApiFailure, type ApiRemedyAction, type ApiRemedyResult, type ApiShell } from '../../../shared/api-service-types'

/** 桥回来的东西一律先校验再上屏：判类不在清单里就当没有，⛔ 把任意文本塞进界面。 */
export function readRemedyResult(raw: string): ApiRemedyResult {
  const value = JSON.parse(raw) as ApiRemedyResult
  if (!value || !['recovered', 'still_failing', 'unknown'].includes(value.outcome) ||
    !apiRemedyActions.includes(value.action) || typeof value.message !== 'string') throw new Error('AI_REMEDY_INVALID')
  return value
}

const outcomeTone = { recovered: 'positive', still_failing: 'danger', unknown: 'neutral' } as const
const outcomeLabel = { recovered: '已恢复', still_failing: '仍有问题', unknown: '不能确认' } as const

/** 这个判类该给哪一个按钮；没有可自动执行的动作就不出按钮（客户按文案自己处理）。 */
export function remedyPlan(code: ApiFailure): { readonly action: ApiRemedyAction; readonly label: string } | null {
  const action = apiFailureRemedy[code]
  return action === null ? null : { action, label: apiRemedyLabels[action] }
}

/** 复验结果怎么显示：三态各自的说法与色调，⛔ 把「命令跑完」说成已恢复。 */
export function remedyOutcomeView(result: Pick<ApiRemedyResult, 'outcome' | 'message' | 'next'>): {
  readonly label: string; readonly tone: 'positive' | 'danger' | 'neutral'; readonly message: string; readonly nextLabel: string | null
} {
  return { label: outcomeLabel[result.outcome], tone: outcomeTone[result.outcome], message: result.message,
    nextLabel: result.next === undefined ? null : apiRemedyLabels[result.next] }
}

export interface RemedyOptions {
  readonly api: Pick<AiAccessApi, 'remedy'> | undefined
  readonly shell: ApiShell
  readonly provider?: AiAccessProvider
  /** 当前的失败判类，决定默认给哪一个动作。 */
  readonly code: ApiFailure
  /** 处理完成后让调用方刷新自己的状态。 */
  readonly onSettled?: (result: ApiRemedyResult) => void
  /** 页面重建后把上次的结果放回去，⛔ 让客户刚看到的结论一刷新就没了。 */
  readonly initial?: ApiRemedyResult | null
}

/**
 * 失败文案旁边只给**一个**主按钮：按 C5 的判类查 `apiFailureRemedy`。
 * 点下去→「处理中…」→复验结果三态，**⛔ 把命令跑完当修好**；没有可自动执行的动作就不出按钮。
 */
export function remedyControl(options: RemedyOptions): HTMLElement | null {
  const plan = remedyPlan(options.code)
  if (plan === null || options.api?.remedy === undefined) return null
  const action = plan.action

  const wrapper = document.createElement('div')
  wrapper.className = 'remedy-control'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'secondary-action remedy-action'
  button.textContent = plan.label
  const status = document.createElement('p')
  status.className = 'remedy-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.hidden = true
  wrapper.append(button, status)

  const settle = (outcome: ApiRemedyResult['outcome'], message: string, next?: ApiRemedyAction): void => {
    status.hidden = false
    status.dataset.outcome = outcome
    status.replaceChildren(pill(outcomeLabel[outcome], outcomeTone[outcome]), document.createTextNode(message))
    button.disabled = false
    button.removeAttribute('aria-busy')
    // 没好就把按钮换成下一步建议的动作，客户不用自己找下一步点哪。
    button.textContent = next === undefined ? apiRemedyLabels[action] : apiRemedyLabels[next]
    button.dataset.nextAction = next ?? action
  }

  if (options.initial && options.initial.shell === options.shell) {
    settle(options.initial.outcome, options.initial.message, options.initial.next)
  }

  button.addEventListener('click', () => {
    if (button.disabled || options.api?.remedy === undefined) return
    const chosen = (button.dataset.nextAction ?? action) as ApiRemedyAction
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = '处理中…'
    status.hidden = true
    void options.api.remedy({ shell: options.shell, action: chosen, provider: options.provider ?? '' }).then(response => {
      const result = readRemedyResult(response.snapshot)
      settle(result.outcome, result.message, result.next)
      options.onSettled?.(result)
    }).catch(() => {
      settle('unknown', `${apiRemedyLabels[chosen]}没有完成，请重试。`)
    })
  })
  return wrapper
}

/** 失败文案：判类 + 这一家服务商的补充说明，与主进程同一份文案表。 */
export function failureText(code: ApiFailure, provider?: AiAccessProvider): string {
  return apiFailureMessage(code, provider)
}

function pill(label: string, tone: 'positive' | 'danger' | 'neutral'): HTMLElement {
  const node = document.createElement('span')
  node.className = 'status-pill'
  node.dataset.tone = tone
  node.textContent = label
  return node
}
