export type Schema =
  | UndefinedSchema
  | StringSchema
  | BooleanSchema
  | ObjectSchema

interface UndefinedSchema {
  readonly kind: 'undefined'
}

interface StringSchema {
  readonly kind: 'string'
  readonly maxLength?: number
}

interface BooleanSchema {
  readonly kind: 'boolean'
}

interface ObjectSchema {
  readonly kind: 'object'
  readonly fields: Readonly<Record<string, Schema>>
}

export const schema = {
  undefined: (): UndefinedSchema => ({ kind: 'undefined' }),
  string: (options: { readonly maxLength?: number } = {}): StringSchema => ({
    kind: 'string',
    maxLength: options.maxLength
  }),
  boolean: (): BooleanSchema => ({ kind: 'boolean' }),
  object: (fields: Readonly<Record<string, Schema>>): ObjectSchema => ({ kind: 'object', fields })
}

/**
 * 说清「哪里不合」——⛔ 只丢一个 ACTION_RESULT_INVALID 让人猜。
 * 返回空数组即匹配。给桥的诊断用；一条动作结果越界时，日志里要能直接看出是哪个字段、多长、限多长。
 */
export function explainMismatch(value: unknown, definition: Schema, path = ''): string[] {
  const at = path === '' ? '结果' : path
  switch (definition.kind) {
    case 'undefined':
      return value === undefined ? [] : [`${at} 应为 undefined，实际 ${typeof value}`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} 应为 boolean，实际 ${typeof value}`]
    case 'string':
      if (typeof value !== 'string') return [`${at} 应为 string，实际 ${typeof value}`]
      return definition.maxLength !== undefined && value.length > definition.maxLength
        ? [`${at} 长度 ${String(value.length)} 超过上限 ${String(definition.maxLength)}`]
        : []
    case 'object': {
      if (!isRecord(value)) return [`${at} 应为对象，实际 ${value === null ? 'null' : typeof value}`]
      const problems: string[] = []
      for (const key of Object.keys(value)) {
        if (!(key in definition.fields)) problems.push(`${at} 多出字段 ${key}`)
      }
      for (const [key, field] of Object.entries(definition.fields)) {
        if (!(key in value)) { problems.push(`${at} 缺字段 ${key}`); continue }
        problems.push(...explainMismatch((value as Record<string, unknown>)[key], field, path === '' ? key : `${path}.${key}`))
      }
      return problems
    }
  }
}

export function matchesSchema(value: unknown, definition: Schema): boolean {
  switch (definition.kind) {
    case 'undefined':
      return value === undefined
    case 'string':
      return (
        typeof value === 'string' &&
        (definition.maxLength === undefined || value.length <= definition.maxLength)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return matchesObject(value, definition)
  }
}

function matchesObject(value: unknown, definition: ObjectSchema): boolean {
  if (!isRecord(value)) {
    return false
  }

  const expectedKeys = Object.keys(definition.fields)
  if (Object.keys(value).some((key) => !expectedKeys.includes(key))) {
    return false
  }

  return expectedKeys.every((key) => matchesSchema(value[key], definition.fields[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
