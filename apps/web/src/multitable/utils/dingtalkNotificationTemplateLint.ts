const VALID_TEMPLATE_PATH = /^[A-Za-z0-9_.]+$/
const KNOWN_TEMPLATE_TOKENS = new Set(['recordId', 'sheetId', 'actorId'])

function isKnownPlaceholderPath(path: string): boolean {
  if (KNOWN_TEMPLATE_TOKENS.has(path)) return true
  if (path.startsWith('record.')) {
    const suffix = path.slice('record.'.length)
    return suffix.length > 0 && !suffix.startsWith('.') && !suffix.endsWith('.') && !suffix.includes('..')
  }
  return false
}

export function listDingTalkTemplateSyntaxWarnings(template: string, isZh = false): string[] {
  const warnings: string[] = []
  const seen = new Set<string>()

  function push(message: string) {
    if (seen.has(message)) return
    seen.add(message)
    warnings.push(message)
  }

  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const raw = match[0]
    const inner = match[1].trim()
    if (!inner) {
      push(isZh ? '不支持空占位符 {{ }}。' : 'Empty placeholder {{ }} is not supported.')
      continue
    }
    if (!VALID_TEMPLATE_PATH.test(inner)) {
      push(isZh
        ? `不支持的占位符语法 ${raw}。请使用字母、数字、"_" 和点路径，例如 {{recordId}} 或 {{record.xxx}}。`
        : `Unsupported placeholder syntax ${raw}. Use letters, numbers, "_" and dot paths such as {{recordId}} or {{record.xxx}}.`)
      continue
    }
    if (!isKnownPlaceholderPath(inner)) {
      push(isZh
        ? `未知占位符 ${raw}。请使用 {{recordId}}、{{sheetId}}、{{actorId}} 或 {{record.fieldName}}。`
        : `Unknown placeholder ${raw}. Use {{recordId}}, {{sheetId}}, {{actorId}}, or {{record.fieldName}}.`)
    }
  }

  const stripped = template.replace(/\{\{[^{}]*\}\}/g, '')
  if (stripped.includes('{{') || stripped.includes('}}')) {
    push(isZh
      ? '检测到未闭合的占位符花括号。请使用类似 {{recordId}} 的完整形式。'
      : 'Unclosed placeholder braces detected. Use complete forms like {{recordId}}.')
  }

  return warnings
}
