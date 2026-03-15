import { describe, expect, it } from 'vitest'
import { validateWorkflowElements } from '../src/views/workflowDesignerValidation'

describe('validateWorkflowElements', () => {
  it('reports missing start and end events', () => {
    expect(validateWorkflowElements([])).toEqual([
      { message: '工作流缺少开始事件', severity: 'error' },
      { message: '工作流缺少结束事件', severity: 'error' },
    ])
  })

  it('warns when there are multiple start events', () => {
    const result = validateWorkflowElements([
      { id: 'start-1', type: 'bpmn:StartEvent' },
      { id: 'start-2', type: 'bpmn:StartEvent' },
      { id: 'end-1', type: 'bpmn:EndEvent' },
    ])

    expect(result).toContainEqual({
      message: '工作流有多个开始事件',
      severity: 'warning',
    })
  })

  it('reports unconnected task and gateway elements', () => {
    const result = validateWorkflowElements([
      { id: 'start-1', type: 'bpmn:StartEvent' },
      { id: 'end-1', type: 'bpmn:EndEvent' },
      {
        id: 'task-1',
        type: 'bpmn:UserTask',
        businessObject: { name: '审批节点' },
        incoming: [],
        outgoing: [],
      },
      {
        id: 'gateway-1',
        type: 'bpmn:ExclusiveGateway',
        incoming: [{}],
        outgoing: [],
      },
    ])

    expect(result).toContainEqual({
      message: '元素没有入口连接',
      severity: 'warning',
      element: '审批节点',
    })
    expect(result).toContainEqual({
      message: '元素没有出口连接',
      severity: 'warning',
      element: '审批节点',
    })
    expect(result).toContainEqual({
      message: '元素没有出口连接',
      severity: 'warning',
      element: 'gateway-1',
    })
  })
})
