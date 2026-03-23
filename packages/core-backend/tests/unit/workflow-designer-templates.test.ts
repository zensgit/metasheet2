import { describe, expect, it } from 'vitest'
import { WorkflowDesigner } from '../../src/workflow/WorkflowDesigner'

describe('WorkflowDesigner builtin attendance starters', () => {
  it('loads attendance-native starter templates into the builtin catalog', () => {
    const designer = new WorkflowDesigner()
    const templates = designer.getTemplates()
    const templateIds = templates.map((template) => template.id)

    expect(templateIds).toEqual(expect.arrayContaining([
      'attendance-leave-manager',
      'attendance-leave-manager-hr',
      'attendance-overtime-manager',
      'attendance-overtime-manager-payroll',
      'attendance-exception-manager',
      'attendance-exception-manager-ops',
    ]))

    const leaveStarter = templates.find((template) => template.id === 'attendance-leave-manager-hr')
    const exceptionStarter = templates.find((template) => template.id === 'attendance-exception-manager-ops')

    expect(leaveStarter).toMatchObject({
      category: 'approval',
      tags: expect.arrayContaining(['attendance', 'leave', 'starter']),
    })
    expect(leaveStarter?.nodes.some((node) => node.name === 'Manager Review')).toBe(true)
    expect(leaveStarter?.nodes.some((node) => node.name === 'HR Review')).toBe(true)
    expect(exceptionStarter?.nodes.some((node) => node.name === 'Attendance Ops Review')).toBe(true)
  })
})
