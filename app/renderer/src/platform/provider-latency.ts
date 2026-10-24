import type { AiAccessApi } from '../../../preload/api/ai-access'
import { apiFailureMessage, apiFailureMessages, type ApiLatency, type ApiShell, type ModelProviderId } from '../../../shared/api-service-types'

export async function measureProviderLatency(api: AiAccessApi, shell: ApiShell, provider: ModelProviderId, key: string, model = ''): Promise<string> {
  try {
    const value = JSON.parse((await api.measureProviderLatency({ shell, provider, key, model })).snapshot) as ApiLatency
    if (value?.ok === true && Number.isFinite(value.latencyMs) && value.latencyMs >= 0) return `API 响应：${Math.round(value.latencyMs)} ms（首段有效回复）`
    if (value?.ok === false && Object.hasOwn(apiFailureMessages, value.code)) return `测速失败：${apiFailureMessage(value.code, provider)}`
  } catch { /* Never echo transport errors, which could contain request credentials. */ }
  return '测速未完成，请检查 Key 和网络后重试。'
}
