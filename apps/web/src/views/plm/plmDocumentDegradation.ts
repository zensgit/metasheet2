export interface PlmDocumentSourceStatus {
  name: string
  ok: boolean
  count: number
  error?: string
}

const DOCUMENT_SOURCE_LABELS: Record<string, string> = {
  attachments: 'attachments（文件附件）',
  related_documents: 'AML related docs（关联文档）',
}

function formatSourceLabel(name: string): string {
  return DOCUMENT_SOURCE_LABELS[name] ?? name
}

function formatFailureDetail(source: PlmDocumentSourceStatus): string {
  const label = formatSourceLabel(source.name)
  return source.error ? `${label}（${source.error}）` : label
}

export function buildPlmDocumentDegradationMessage(
  sources: PlmDocumentSourceStatus[],
): { warning?: string; error?: string } {
  if (!Array.isArray(sources) || sources.length === 0) return {}

  const failed = sources.filter(source => !source.ok)
  if (failed.length === 0) return {}

  const failedLabels = failed.map(formatFailureDetail)
  if (failed.length >= sources.length) {
    return {
      error: `文档数据源均不可用：${failedLabels.join('、')}`,
    }
  }

  return {
    warning: `${failedLabels.join('、')}不可用，当前显示可能不完整`,
  }
}
