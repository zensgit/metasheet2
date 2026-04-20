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

export function listDingTalkTemplateSyntaxWarnings(template: string): string[] {
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
      push('Empty placeholder {{ }} is not supported.')
      continue
    }
    if (!VALID_TEMPLATE_PATH.test(inner)) {
      push(`Unsupported placeholder syntax ${raw}. Use letters, numbers, "_" and dot paths such as {{recordId}} or {{record.xxx}}.`)
      continue
    }
    if (!isKnownPlaceholderPath(inner)) {
      push(`Unknown placeholder ${raw}. Use {{recordId}}, {{sheetId}}, {{actorId}}, or {{record.fieldName}}.`)
    }
  }

  const stripped = template.replace(/\{\{[^{}]*\}\}/g, '')
  if (stripped.includes('{{') || stripped.includes('}}')) {
    push('Unclosed placeholder braces detected. Use complete forms like {{recordId}}.')
  }

  return warnings
}
