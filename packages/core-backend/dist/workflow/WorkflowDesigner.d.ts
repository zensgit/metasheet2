/**
 * Visual Workflow Designer (n8n Style)
 * BPMN/DAG workflow visual editor backend support
 */
import { EventEmitter } from 'events';
export interface WorkflowNode {
    id: string;
    type: 'startEvent' | 'endEvent' | 'userTask' | 'serviceTask' | 'scriptTask' | 'exclusiveGateway' | 'parallelGateway' | 'intermediateCatchEvent';
    name: string;
    position: {
        x: number;
        y: number;
    };
    data: {
        properties?: Record<string, any>;
        formKey?: string;
        assignee?: string;
        candidateUsers?: string[];
        candidateGroups?: string[];
        script?: string;
        serviceClass?: string;
        condition?: string;
        timerDefinition?: any;
        messageRef?: string;
        signalRef?: string;
    };
}
export interface WorkflowEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    condition?: string;
    type?: 'default' | 'conditional';
}
export interface WorkflowDefinition {
    id?: string;
    name: string;
    description?: string;
    version?: number;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    variables?: Record<string, any>;
    category?: string;
    tags?: string[];
}
export declare class WorkflowDesigner extends EventEmitter {
    private logger;
    private nodeTypes;
    private templates;
    constructor();
    /**
     * Initialize available node types
     */
    private initializeNodeTypes;
    /**
     * Load workflow templates
     */
    private loadTemplates;
    /**
     * Get available node types
     */
    getNodeTypes(): any[];
    /**
     * Get workflow templates
     */
    getTemplates(): WorkflowDefinition[];
    /**
     * Save workflow definition
     */
    saveWorkflow(definition: WorkflowDefinition): Promise<string>;
    /**
     * Load workflow definition
     */
    loadWorkflow(workflowId: string): Promise<WorkflowDefinition | null>;
    /**
     * List workflows
     */
    listWorkflows(category?: string): Promise<any[]>;
    /**
     * Validate workflow definition
     */
    validateWorkflow(definition: WorkflowDefinition): {
        valid: boolean;
        errors: string[];
    };
    /**
     * Convert visual definition to BPMN XML
     */
    private convertToBPMN;
    /**
     * Convert node to BPMN XML
     */
    private nodeToXML;
    /**
     * Deploy workflow to engine
     */
    deployWorkflow(workflowId: string): Promise<string>;
}
export default WorkflowDesigner;
//# sourceMappingURL=WorkflowDesigner.d.ts.map