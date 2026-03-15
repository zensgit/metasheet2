export interface WorkflowValidationError {
  message: string
  severity: 'error' | 'warning'
  element?: string
}

export interface WorkflowValidationElement {
  id: string
  type: string
  businessObject?: {
    name?: string
  }
  incoming?: unknown[]
  outgoing?: unknown[]
}

function isFlowElement(type: string): boolean {
  return type === 'bpmn:SequenceFlow'
}

function isTaskOrGateway(type: string): boolean {
  return type.includes('Task') || type.includes('Gateway')
}

export function validateWorkflowElements(
  elements: readonly WorkflowValidationElement[],
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = []

  const startEvents = elements.filter(element => element.type === 'bpmn:StartEvent')
  if (startEvents.length === 0) {
    errors.push({
      message: '工作流缺少开始事件',
      severity: 'error',
    })
  } else if (startEvents.length > 1) {
    errors.push({
      message: '工作流有多个开始事件',
      severity: 'warning',
    })
  }

  const endEvents = elements.filter(element => element.type === 'bpmn:EndEvent')
  if (endEvents.length === 0) {
    errors.push({
      message: '工作流缺少结束事件',
      severity: 'error',
    })
  }

  elements.forEach(element => {
    if (isFlowElement(element.type) || !isTaskOrGateway(element.type)) return

    const incoming = Array.isArray(element.incoming) ? element.incoming : []
    const outgoing = Array.isArray(element.outgoing) ? element.outgoing : []
    const label = element.businessObject?.name || element.id

    if (incoming.length === 0) {
      errors.push({
        message: '元素没有入口连接',
        severity: 'warning',
        element: label,
      })
    }

    if (outgoing.length === 0) {
      errors.push({
        message: '元素没有出口连接',
        severity: 'warning',
        element: label,
      })
    }
  })

  return errors
}
