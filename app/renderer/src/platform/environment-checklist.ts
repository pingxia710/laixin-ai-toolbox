export type EnvironmentChecklistDetectionMode = 'automatic' | 'user-action' | 'unsupported'
export type EnvironmentChecklistHandlingMode = 'automatic-fix' | 'user-action' | 'do-not-do'

export interface EnvironmentChecklistItem {
  readonly id: number
  readonly title: string
  readonly detection: { readonly mode: EnvironmentChecklistDetectionMode; readonly strategy: string }
  readonly handling: { readonly mode: EnvironmentChecklistHandlingMode; readonly strategy: string }
  readonly safetyBoundaryReason: string
}

export const environmentChecklistDetectionLabels: Readonly<Record<EnvironmentChecklistDetectionMode, string>> = {
  automatic: '工具箱可检查',
  'user-action': '需要你确认',
  unsupported: '工具箱不扫描'
}

export const environmentChecklistHandlingLabels: Readonly<Record<EnvironmentChecklistHandlingMode, string>> = {
  'automatic-fix': '工具箱可在明确操作后处理',
  'user-action': '需要你或管理员处理',
  'do-not-do': '工具箱明确不做'
}

/** The static 27-item boundary is accepted only as a complete, ordered public contract. */
export function readEnvironmentChecklist(snapshot: string): readonly EnvironmentChecklistItem[] {
  let value: unknown
  try { value = JSON.parse(snapshot) } catch { throw new Error('AI_ENVIRONMENT_CHECKLIST_INVALID') }
  if (!Array.isArray(value) || value.length !== 27) throw new Error('AI_ENVIRONMENT_CHECKLIST_INVALID')
  const result: EnvironmentChecklistItem[] = []
  for (const [index, item] of value.entries()) {
    if (!record(item) || item.id !== index + 1 || !shortText(item.title) || !record(item.detection) || !record(item.handling) ||
      !detectionMode(item.detection.mode) || !shortText(item.detection.strategy) || !handlingMode(item.handling.mode) ||
      !shortText(item.handling.strategy) || !shortText(item.safetyBoundaryReason)) {
      throw new Error('AI_ENVIRONMENT_CHECKLIST_INVALID')
    }
    result.push({
      id: item.id,
      title: item.title,
      detection: { mode: item.detection.mode, strategy: item.detection.strategy },
      handling: { mode: item.handling.mode, strategy: item.handling.strategy },
      safetyBoundaryReason: item.safetyBoundaryReason
    })
  }
  return result
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectionMode(value: unknown): value is EnvironmentChecklistDetectionMode {
  return value === 'automatic' || value === 'user-action' || value === 'unsupported'
}

function handlingMode(value: unknown): value is EnvironmentChecklistHandlingMode {
  return value === 'automatic-fix' || value === 'user-action' || value === 'do-not-do'
}

function shortText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_000
}
