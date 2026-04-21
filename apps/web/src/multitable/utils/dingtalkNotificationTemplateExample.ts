function lookupTemplateValue(path: string, data: Record<string, unknown>): unknown {
  const segments = path.split('.').filter(Boolean)
  let current: unknown = data
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function renderTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

const EXAMPLE_TEMPLATE_DATA: Record<string, unknown> = {
  sheetId: 'sheet_demo_001',
  recordId: 'record_demo_001',
  actorId: 'user_demo_001',
  record: {
    title: '示例申请单',
    status: '待处理',
    owner: '示例负责人',
    name: '示例联系人',
    email: 'demo@example.com',
    mobile: '13900001234',
    xxx: '示例字段值',
  },
}

export function renderDingTalkTemplateExample(template: string): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) =>
    renderTemplateValue(lookupTemplateValue(key, EXAMPLE_TEMPLATE_DATA)),
  )
}
