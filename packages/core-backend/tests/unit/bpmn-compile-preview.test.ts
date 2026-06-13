import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compileBpmnPreview,
  type BpmnCompilePreview,
} from '../../src/workflow/bpmnCompilePreview'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../../src/workflow/WorkflowDesigner'

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return {
    id: 'wf_1',
    name: 'Preview workflow',
    version: 1,
    nodes,
    edges,
  }
}

function node(
  id: string,
  type: WorkflowNode['type'],
  properties: Record<string, unknown> = {},
  name = id,
): WorkflowNode {
  return {
    id,
    type,
    name,
    position: { x: 0, y: 0 },
    data: { properties },
  }
}

function edge(
  id: string,
  source: string,
  target: string,
  extras: Partial<WorkflowEdge> = {},
): WorkflowEdge {
  return { id, source, target, ...extras }
}

function action(type: string, config: Record<string, unknown>): Record<string, unknown> {
  return { actionType: type, config }
}

function previewFor(visual: WorkflowDefinition): BpmnCompilePreview {
  return compileBpmnPreview({ mode: 'visual', workflowId: visual.id, sourceVersion: visual.version, visual })
}

describe('compileBpmnPreview — A6-4a pure compiler', () => {
  it('maps visual start/end-only input as structural and emits no actions', () => {
    const result = previewFor(workflow([
      node('start', 'startEvent'),
      node('end', 'endEvent'),
    ], [
      edge('flow_start_end', 'start', 'end'),
    ]))

    expect(result.supported).toBe(true)
    expect(result.automationPreview?.actions).toEqual([])
    expect(result.gapReport).toEqual([])
    expect(result.mappingReport).toEqual([
      { bpmnElementId: 'end', bpmnElementType: 'endEvent', target: 'structural', targetKind: 'endEvent' },
      { bpmnElementId: 'start', bpmnElementType: 'startEvent', target: 'structural', targetKind: 'startEvent' },
    ])
  })

  it('maps visual exclusive gateway to condition_branch when default and conditions are representable', () => {
    const visual = workflow([
      node('start', 'startEvent'),
      node('gw_decide', 'exclusiveGateway'),
      node('task_vip', 'serviceTask', action('update_record', { fields: { tier: 'vip' } })),
      node('task_default', 'serviceTask', action('send_notification', { userIds: ['ops'], message: 'normal' })),
      node('end_vip', 'endEvent'),
      node('end_default', 'endEvent'),
    ], [
      edge('flow_start_gw', 'start', 'gw_decide'),
      edge('flow_vip', 'gw_decide', 'task_vip', { label: 'vip', condition: 'tier == "vip"' }),
      edge('flow_default', 'gw_decide', 'task_default', { label: 'fallback', type: 'default' }),
      edge('flow_vip_end', 'task_vip', 'end_vip'),
      edge('flow_default_end', 'task_default', 'end_default'),
    ])

    const result = previewFor(visual)
    const actions = result.automationPreview?.actions as Array<{
      type: string
      config: {
        branches: Array<{ key: string; conditions: { conditions: Array<Record<string, unknown>> }; actions: Array<{ type: string }> }>
        defaultBranch: { key: string; actions: Array<{ type: string }> }
      }
    }>

    expect(result.supported).toBe(true)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('condition_branch')
    expect(actions[0]?.config.branches[0]).toMatchObject({
      key: 'vip',
      conditions: { conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
      actions: [{ type: 'update_record' }],
    })
    expect(actions[0]?.config.defaultBranch).toMatchObject({
      key: 'fallback',
      actions: [{ type: 'send_notification' }],
    })
    expect(result.mappingReport).toContainEqual({
      bpmnElementId: 'gw_decide',
      bpmnElementType: 'exclusiveGateway',
      target: 'automation',
      targetKind: 'condition_branch',
    })
  })

  it('reports a gap for visual exclusive gateway without a default path', () => {
    const result = previewFor(workflow([
      node('gw_no_default', 'exclusiveGateway'),
      node('task_a', 'serviceTask', action('update_record', { fields: { status: 'a' } })),
      node('task_b', 'serviceTask', action('update_record', { fields: { status: 'b' } })),
    ], [
      edge('flow_a', 'gw_no_default', 'task_a', { condition: 'status == "a"' }),
      edge('flow_b', 'gw_no_default', 'task_b', { condition: 'status == "b"' }),
    ]))

    expect(result.supported).toBe(false)
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'gw_no_default',
        bpmnElementType: 'exclusiveGateway',
        reason: 'Exclusive gateway requires one default path to map to condition_branch',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('keeps branch-local wait/start primitives out of condition_branch preview until A6-3-3', () => {
    const result = previewFor(workflow([
      node('gw_decide', 'exclusiveGateway'),
      node('task_wait', 'serviceTask', action('wait_for_callback', { callbackKey: 'callback-1' })),
      node('task_default', 'serviceTask', action('update_record', { fields: { status: 'fallback' } })),
      node('end_wait', 'endEvent'),
      node('end_default', 'endEvent'),
    ], [
      edge('flow_wait', 'gw_decide', 'task_wait', { condition: 'needsCallback == true' }),
      edge('flow_default', 'gw_decide', 'task_default', { type: 'default' }),
      edge('flow_wait_end', 'task_wait', 'end_wait'),
      edge('flow_default_end', 'task_default', 'end_default'),
    ]))

    expect(result.supported).toBe(false)
    expect(result.automationPreview?.actions).toEqual([])
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'gw_decide',
        bpmnElementType: 'exclusiveGateway',
        reason: 'Exclusive gateway path flow_wait is not representable: service task task_wait action wait_for_callback is not supported in this branch context',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('maps visual parallel split/join to parallel_branch join-all', () => {
    const visual = workflow([
      node('gw_split', 'parallelGateway'),
      node('task_ops', 'serviceTask', action('update_record', { fields: { status: 'ops' } })),
      node('task_notify', 'serviceTask', action('send_notification', { userIds: ['u1'], message: 'ready' })),
      node('gw_join', 'parallelGateway'),
      node('end', 'endEvent'),
    ], [
      edge('flow_ops', 'gw_split', 'task_ops', { label: 'Ops branch' }),
      edge('flow_notify', 'gw_split', 'task_notify', { label: 'Notify branch' }),
      edge('flow_ops_join', 'task_ops', 'gw_join'),
      edge('flow_notify_join', 'task_notify', 'gw_join'),
      edge('flow_join_end', 'gw_join', 'end'),
    ])

    const result = previewFor(visual)
    const actions = result.automationPreview?.actions as Array<{
      type: string
      config: { joinMode: string; branches: Array<{ key: string; label?: string; actions: Array<{ type: string }> }> }
    }>

    expect(result.supported).toBe(true)
    expect(actions).toEqual([
      {
        type: 'parallel_branch',
        config: {
          joinMode: 'all',
          branches: [
            { key: 'Notify_branch', label: 'Notify branch', actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'ready' } }] },
            { key: 'Ops_branch', label: 'Ops branch', actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }] },
          ],
        },
      },
    ])
    expect(result.mappingReport).toContainEqual({
      bpmnElementId: 'gw_split',
      bpmnElementType: 'parallelGateway',
      target: 'automation',
      targetKind: 'parallel_branch',
    })
    expect(result.mappingReport).toContainEqual({
      bpmnElementId: 'gw_join',
      bpmnElementType: 'parallelGateway',
      target: 'structural',
      targetKind: 'parallel_join',
    })
  })

  it('keeps parallel_branch preview aligned with the landed A6-3-4 branch action set', () => {
    const result = previewFor(workflow([
      node('gw_split', 'parallelGateway'),
      node('task_webhook', 'serviceTask', action('send_webhook', { url: 'https://example.test/hook' })),
      node('task_notify', 'serviceTask', action('send_notification', { userIds: ['u1'], message: 'ready' })),
      node('gw_join', 'parallelGateway'),
    ], [
      edge('flow_webhook', 'gw_split', 'task_webhook'),
      edge('flow_notify', 'gw_split', 'task_notify'),
      edge('flow_webhook_join', 'task_webhook', 'gw_join'),
      edge('flow_notify_join', 'task_notify', 'gw_join'),
    ]))

    expect(result.supported).toBe(false)
    expect(result.automationPreview?.actions).toEqual([])
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'gw_split',
        bpmnElementType: 'parallelGateway',
        reason: 'Parallel gateway branch flow_webhook is not representable: service task task_webhook action send_webhook is not supported in parallel_branch',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('keeps empty visual parallel branches out of supported parallel_branch preview', () => {
    const result = previewFor(workflow([
      node('gw_split', 'parallelGateway'),
      node('task_notify', 'serviceTask', action('send_notification', { userIds: ['u1'], message: 'ready' })),
      node('gw_join', 'parallelGateway'),
    ], [
      edge('flow_empty', 'gw_split', 'gw_join'),
      edge('flow_notify', 'gw_split', 'task_notify'),
      edge('flow_notify_join', 'task_notify', 'gw_join'),
    ]))

    expect(result.supported).toBe(false)
    expect(result.automationPreview?.actions).toEqual([])
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'gw_split',
        bpmnElementType: 'parallelGateway',
        reason: 'Parallel gateway branch flow_empty is not representable: parallel branch must contain at least one action',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('reports gaps for unmatched or ambiguous parallel gateways', () => {
    const result = previewFor(workflow([
      node('gw_split', 'parallelGateway'),
      node('task_a', 'serviceTask', action('update_record', { fields: { a: '1' } })),
      node('task_b', 'serviceTask', action('update_record', { fields: { b: '1' } })),
    ], [
      edge('flow_a', 'gw_split', 'task_a'),
      edge('flow_b', 'gw_split', 'task_b'),
    ]))

    expect(result.supported).toBe(false)
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'gw_split',
        bpmnElementType: 'parallelGateway',
        reason: 'Parallel gateway branch flow_a is not representable: service task task_a must lead to one join path',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('reports deterministic gaps for unsupported BPMN elements', () => {
    const visual = workflow([
      node('script_secret', 'scriptTask', {}, 'Bearer abcdefghijklmnopqrstuvwxyz'),
      node('inclusive', 'inclusiveGateway' as WorkflowNode['type']),
      node('event_gw', 'eventBasedGateway' as WorkflowNode['type']),
      node('sub', 'subProcess' as WorkflowNode['type']),
      node('boundary', 'boundaryEvent' as WorkflowNode['type']),
      node('call', 'callActivity' as WorkflowNode['type']),
    ])

    const result = previewFor(visual)
    expect(result.supported).toBe(false)
    expect(result.gapReport.map((gap) => [gap.bpmnElementId, gap.bpmnElementType, gap.requiredRung])).toEqual([
      ['boundary', 'boundaryEvent', 'unsupported'],
      ['call', 'callActivity', 'unsupported'],
      ['event_gw', 'eventBasedGateway', 'unsupported'],
      ['inclusive', 'inclusiveGateway', 'unsupported'],
      ['script_secret', 'scriptTask', 'unsupported'],
      ['sub', 'subProcess', 'unsupported'],
    ])
    expect(result.gapReport.find((gap) => gap.bpmnElementId === 'script_secret')?.reason).toContain('Bearer <redacted>')
  })

  it('does not leak unsupported gateway downstream service tasks into top-level preview actions', () => {
    const result = previewFor(workflow([
      node('inclusive', 'inclusiveGateway' as WorkflowNode['type']),
      node('task_after', 'serviceTask', action('update_record', { fields: { status: 'after' } })),
      node('end', 'endEvent'),
    ], [
      edge('flow_after', 'inclusive', 'task_after'),
      edge('flow_end', 'task_after', 'end'),
    ]))

    expect(result.supported).toBe(false)
    expect(result.automationPreview?.actions).toEqual([])
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'inclusive',
        bpmnElementType: 'inclusiveGateway',
        reason: 'Unsupported BPMN element: inclusive',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('reports timer/message/signal catch events as gated gaps and never maps them to wait_for_callback', () => {
    const result = compileBpmnPreview({
      mode: 'bpmn_xml',
      workflowId: 'xml_catches',
      bpmnXml: `
        <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
          <bpmn:process id="proc">
            <bpmn:intermediateCatchEvent id="catch_message"><bpmn:messageEventDefinition /></bpmn:intermediateCatchEvent>
            <bpmn:intermediateCatchEvent id="catch_signal"><bpmn:signalEventDefinition /></bpmn:intermediateCatchEvent>
            <bpmn:intermediateCatchEvent id="catch_timer"><bpmn:timerEventDefinition /></bpmn:intermediateCatchEvent>
          </bpmn:process>
        </bpmn:definitions>
      `,
    })

    expect(result.automationPreview?.actions).toEqual([])
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'catch_message',
        bpmnElementType: 'intermediateCatchEvent',
        reason: 'intermediateCatchEvent requires a separately scoped resume trigger',
        requiredRung: 'public-webhook',
      },
      {
        bpmnElementId: 'catch_signal',
        bpmnElementType: 'intermediateCatchEvent',
        reason: 'intermediateCatchEvent requires a separately scoped resume trigger',
        requiredRung: 'public-webhook',
      },
      {
        bpmnElementId: 'catch_timer',
        bpmnElementType: 'intermediateCatchEvent',
        reason: 'intermediateCatchEvent requires a separately scoped resume trigger',
        requiredRung: 'unsupported',
      },
    ])
  })

  it('returns a deterministic invalid-XML gap instead of throwing', () => {
    const result = compileBpmnPreview({
      mode: 'bpmn_xml',
      bpmnXml: '<bpmn:definitions><bpmn:startEvent id="start">',
    })

    expect(result).toMatchObject({
      supported: false,
      gapReport: [
        {
          bpmnElementId: '__bpmn_xml__',
          bpmnElementType: 'bpmn_xml',
          reason: 'Invalid BPMN XML',
          requiredRung: 'unsupported',
        },
      ],
    })
  })

  it('redacts secret-shaped values in returned preview sections', () => {
    const result = previewFor(workflow([
      node('send_secret', 'serviceTask', action('send_webhook', {
        url: 'https://example.com/hook?access_token=topsecret',
        headers: {
          Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
          'X-API-Key': 'sk-abcdefghijklmnopqrstuvwxyz123456',
        },
        body: 'postgres://user:password@example/db',
      })),
      node('script_secret', 'scriptTask', {}, 'SECRET_TOKEN=super-secret-value'),
    ]))
    const json = JSON.stringify(result)

    expect(json).not.toContain('topsecret')
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
    expect(json).not.toContain('user:password')
    expect(json).not.toContain('super-secret-value')
    expect(json).toContain('<redacted>')
  })

  it('produces byte-stable output for equivalent input', () => {
    const visual = workflow([
      node('start', 'startEvent'),
      node('task', 'serviceTask', action('update_record', { fields: { status: 'done' } })),
      node('end', 'endEvent'),
    ], [
      edge('flow_1', 'start', 'task'),
      edge('flow_2', 'task', 'end'),
    ])

    expect(JSON.stringify(previewFor(visual))).toBe(JSON.stringify(previewFor(visual)))
  })

  it('keeps the A6-4a compiler isolated from live runtime, routes, db, and mutating services', () => {
    const source = readFileSync(new URL('../../src/workflow/bpmnCompilePreview.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/BPMNWorkflowEngine/)
    expect(source).not.toMatch(/from ['"].*routes/)
    expect(source).not.toMatch(/from ['"].*db/)
    expect(source).not.toMatch(/ApprovalProductService/)
    expect(source).not.toMatch(/AutomationService/)
    expect(source).not.toMatch(/deployProcess|startProcess|resumeAutomation|retryExecution/)
  })
})
