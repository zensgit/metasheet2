import BpmnModeler from 'bpmn-js/lib/Modeler'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css'

export type WorkflowModelerCtor = typeof BpmnModeler
export type WorkflowModelerOptions = ConstructorParameters<WorkflowModelerCtor>[0]
export type WorkflowModelerInstance = InstanceType<WorkflowModelerCtor>

export function createWorkflowModeler(options: WorkflowModelerOptions): WorkflowModelerInstance {
  return new BpmnModeler(options)
}
