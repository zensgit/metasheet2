/**
 * Visual Workflow Designer (n8n Style)
 * BPMN/DAG workflow visual editor backend support
 */
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { db } from '../db/db';
import { v4 as uuidv4 } from 'uuid';
export class WorkflowDesigner extends EventEmitter {
    logger;
    nodeTypes;
    templates;
    constructor() {
        super();
        this.logger = new Logger('WorkflowDesigner');
        this.nodeTypes = new Map();
        this.templates = new Map();
        this.initializeNodeTypes();
        this.loadTemplates();
    }
    /**
     * Initialize available node types
     */
    initializeNodeTypes() {
        const nodeTypes = {
            startEvent: {
                type: 'startEvent',
                name: 'Start Event',
                description: 'Starts the workflow process',
                icon: 'play-circle',
                category: 'events',
                properties: {
                    initiator: { type: 'string', label: 'Initiator' },
                    formKey: { type: 'string', label: 'Start Form' }
                }
            },
            endEvent: {
                type: 'endEvent',
                name: 'End Event',
                description: 'Terminates the workflow process',
                icon: 'stop-circle',
                category: 'events',
                properties: {}
            },
            userTask: {
                type: 'userTask',
                name: 'User Task',
                description: 'Human task requiring user interaction',
                icon: 'user',
                category: 'tasks',
                properties: {
                    assignee: { type: 'string', label: 'Assignee' },
                    candidateUsers: { type: 'array', label: 'Candidate Users' },
                    candidateGroups: { type: 'array', label: 'Candidate Groups' },
                    priority: { type: 'number', label: 'Priority', default: 50 },
                    dueDate: { type: 'date', label: 'Due Date' },
                    formKey: { type: 'string', label: 'Form Key' }
                }
            },
            serviceTask: {
                type: 'serviceTask',
                name: 'Service Task',
                description: 'Automated system task',
                icon: 'cog',
                category: 'tasks',
                properties: {
                    serviceClass: { type: 'string', label: 'Service Class' },
                    method: { type: 'string', label: 'Method' },
                    timeout: { type: 'number', label: 'Timeout (ms)', default: 30000 },
                    retries: { type: 'number', label: 'Retries', default: 3 }
                }
            },
            scriptTask: {
                type: 'scriptTask',
                name: 'Script Task',
                description: 'Execute JavaScript code',
                icon: 'code',
                category: 'tasks',
                properties: {
                    script: { type: 'code', label: 'Script', language: 'javascript' },
                    resultVariable: { type: 'string', label: 'Result Variable' }
                }
            },
            exclusiveGateway: {
                type: 'exclusiveGateway',
                name: 'Exclusive Gateway',
                description: 'Route execution based on conditions',
                icon: 'diamond',
                category: 'gateways',
                properties: {
                    defaultFlow: { type: 'string', label: 'Default Flow' }
                }
            },
            parallelGateway: {
                type: 'parallelGateway',
                name: 'Parallel Gateway',
                description: 'Split/join parallel execution paths',
                icon: 'diamond-plus',
                category: 'gateways',
                properties: {}
            },
            intermediateCatchEvent: {
                type: 'intermediateCatchEvent',
                name: 'Intermediate Catch Event',
                description: 'Wait for specific event',
                icon: 'clock',
                category: 'events',
                properties: {
                    eventType: { type: 'select', label: 'Event Type', options: ['timer', 'message', 'signal'] },
                    timerType: { type: 'select', label: 'Timer Type', options: ['duration', 'date', 'cycle'] },
                    timerValue: { type: 'string', label: 'Timer Value' },
                    messageRef: { type: 'string', label: 'Message Reference' },
                    signalRef: { type: 'string', label: 'Signal Reference' }
                }
            }
        };
        for (const [type, definition] of Object.entries(nodeTypes)) {
            this.nodeTypes.set(type, definition);
        }
        this.logger.info(`Initialized ${this.nodeTypes.size} node types`);
    }
    /**
     * Load workflow templates
     */
    async loadTemplates() {
        const templates = [
            {
                id: 'simple-approval',
                name: 'Simple Approval Workflow',
                description: 'Basic approval workflow with user task',
                category: 'approval',
                nodes: [
                    {
                        id: 'start',
                        type: 'startEvent',
                        name: 'Start',
                        position: { x: 100, y: 200 },
                        data: { properties: { initiator: '${initiator}' } }
                    },
                    {
                        id: 'approve-task',
                        type: 'userTask',
                        name: 'Approve Request',
                        position: { x: 300, y: 200 },
                        data: {
                            assignee: '${approver}',
                            formKey: 'approval-form',
                            properties: { priority: 50 }
                        }
                    },
                    {
                        id: 'gateway',
                        type: 'exclusiveGateway',
                        name: 'Approved?',
                        position: { x: 500, y: 200 },
                        data: { properties: { defaultFlow: 'rejected' } }
                    },
                    {
                        id: 'approved-end',
                        type: 'endEvent',
                        name: 'Approved',
                        position: { x: 700, y: 150 },
                        data: {}
                    },
                    {
                        id: 'rejected-end',
                        type: 'endEvent',
                        name: 'Rejected',
                        position: { x: 700, y: 250 },
                        data: {}
                    }
                ],
                edges: [
                    { id: 'flow1', source: 'start', target: 'approve-task' },
                    { id: 'flow2', source: 'approve-task', target: 'gateway' },
                    { id: 'flow3', source: 'gateway', target: 'approved-end', condition: '${approved}', label: 'Yes' },
                    { id: 'flow4', source: 'gateway', target: 'rejected-end', type: 'default', label: 'No' }
                ],
                variables: {
                    initiator: { type: 'string', required: true },
                    approver: { type: 'string', required: true },
                    approved: { type: 'boolean', default: false }
                }
            },
            {
                id: 'parallel-review',
                name: 'Parallel Review Workflow',
                description: 'Multiple reviewers in parallel',
                category: 'approval',
                nodes: [
                    {
                        id: 'start',
                        type: 'startEvent',
                        name: 'Start',
                        position: { x: 100, y: 300 },
                        data: {}
                    },
                    {
                        id: 'parallel-split',
                        type: 'parallelGateway',
                        name: 'Split',
                        position: { x: 250, y: 300 },
                        data: {}
                    },
                    {
                        id: 'review-1',
                        type: 'userTask',
                        name: 'Technical Review',
                        position: { x: 400, y: 200 },
                        data: {
                            candidateGroups: ['technical-reviewers'],
                            formKey: 'technical-review-form'
                        }
                    },
                    {
                        id: 'review-2',
                        type: 'userTask',
                        name: 'Business Review',
                        position: { x: 400, y: 400 },
                        data: {
                            candidateGroups: ['business-reviewers'],
                            formKey: 'business-review-form'
                        }
                    },
                    {
                        id: 'parallel-join',
                        type: 'parallelGateway',
                        name: 'Join',
                        position: { x: 600, y: 300 },
                        data: {}
                    },
                    {
                        id: 'final-approval',
                        type: 'userTask',
                        name: 'Final Approval',
                        position: { x: 750, y: 300 },
                        data: {
                            candidateGroups: ['managers'],
                            formKey: 'final-approval-form'
                        }
                    },
                    {
                        id: 'end',
                        type: 'endEvent',
                        name: 'End',
                        position: { x: 900, y: 300 },
                        data: {}
                    }
                ],
                edges: [
                    { id: 'flow1', source: 'start', target: 'parallel-split' },
                    { id: 'flow2', source: 'parallel-split', target: 'review-1' },
                    { id: 'flow3', source: 'parallel-split', target: 'review-2' },
                    { id: 'flow4', source: 'review-1', target: 'parallel-join' },
                    { id: 'flow5', source: 'review-2', target: 'parallel-join' },
                    { id: 'flow6', source: 'parallel-join', target: 'final-approval' },
                    { id: 'flow7', source: 'final-approval', target: 'end' }
                ],
                variables: {
                    technicalApproved: { type: 'boolean', default: false },
                    businessApproved: { type: 'boolean', default: false },
                    finalApproved: { type: 'boolean', default: false }
                }
            }
        ];
        for (const template of templates) {
            this.templates.set(template.id, template);
        }
        this.logger.info(`Loaded ${this.templates.size} workflow templates`);
    }
    /**
     * Get available node types
     */
    getNodeTypes() {
        return Array.from(this.nodeTypes.values());
    }
    /**
     * Get workflow templates
     */
    getTemplates() {
        return Array.from(this.templates.values());
    }
    /**
     * Save workflow definition
     */
    async saveWorkflow(definition) {
        const workflowId = definition.id || uuidv4();
        try {
            // Convert visual definition to BPMN XML
            const bpmnXml = this.convertToBPMN(definition);
            // Save to database using workflow_definitions table
            await db
                .insertInto('workflow_definitions')
                .values({
                name: definition.name,
                version: String(definition.version || 1),
                type: 'BPMN',
                definition: JSON.stringify({
                    visual: definition,
                    bpmn: bpmnXml,
                    description: definition.description,
                    category: definition.category,
                    tags: definition.tags || []
                }),
                status: 'ACTIVE',
                variables_schema: null,
                settings: JSON.stringify({}),
                created_by: null
            })
                .onConflict((oc) => oc.column('id').doUpdateSet({
                name: definition.name,
                version: String(definition.version || 1),
                definition: JSON.stringify({
                    visual: definition,
                    bpmn: bpmnXml,
                    description: definition.description,
                    category: definition.category,
                    tags: definition.tags || []
                })
            }))
                .execute();
            this.emit('workflow:saved', { workflowId, name: definition.name });
            this.logger.info(`Saved workflow: ${definition.name} (${workflowId})`);
            return workflowId;
        }
        catch (error) {
            this.logger.error(`Failed to save workflow: ${error}`);
            throw error;
        }
    }
    /**
     * Load workflow definition
     */
    async loadWorkflow(workflowId) {
        try {
            const workflow = await db
                .selectFrom('workflow_definitions')
                .selectAll()
                .where('id', '=', workflowId)
                .executeTakeFirst();
            if (!workflow) {
                return null;
            }
            const definition = JSON.parse(workflow.definition);
            return definition.visual;
        }
        catch (error) {
            this.logger.error(`Failed to load workflow: ${error}`);
            throw error;
        }
    }
    /**
     * List workflows
     */
    async listWorkflows(category) {
        try {
            let query = db
                .selectFrom('workflow_definitions')
                .select(['id', 'name', 'version', 'type', 'status', 'created_at', 'updated_at']);
            // Note: category filtering would need to be done by parsing definition JSON
            // For now, we just list all workflows
            const workflows = await query
                .orderBy('updated_at', 'desc')
                .execute();
            // Parse definition JSON to extract additional metadata like tags
            return workflows.map(w => {
                try {
                    const definition = JSON.parse(w.definition);
                    return {
                        ...w,
                        tags: definition.tags || [],
                        description: definition.description || '',
                        category: definition.category || ''
                    };
                }
                catch {
                    return { ...w, tags: [], description: '', category: '' };
                }
            });
        }
        catch (error) {
            this.logger.error(`Failed to list workflows: ${error}`);
            throw error;
        }
    }
    /**
     * Validate workflow definition
     */
    validateWorkflow(definition) {
        const errors = [];
        // Check for start event
        const startEvents = definition.nodes.filter(n => n.type === 'startEvent');
        if (startEvents.length === 0) {
            errors.push('Workflow must have at least one start event');
        }
        if (startEvents.length > 1) {
            errors.push('Workflow can only have one start event');
        }
        // Check for end event
        const endEvents = definition.nodes.filter(n => n.type === 'endEvent');
        if (endEvents.length === 0) {
            errors.push('Workflow must have at least one end event');
        }
        // Check node connections
        for (const node of definition.nodes) {
            if (node.type === 'startEvent') {
                const outgoing = definition.edges.filter(e => e.source === node.id);
                if (outgoing.length === 0) {
                    errors.push(`Start event '${node.name}' has no outgoing connections`);
                }
            }
            if (node.type === 'endEvent') {
                const incoming = definition.edges.filter(e => e.target === node.id);
                if (incoming.length === 0) {
                    errors.push(`End event '${node.name}' has no incoming connections`);
                }
            }
            if (['userTask', 'serviceTask', 'scriptTask'].includes(node.type)) {
                const incoming = definition.edges.filter(e => e.target === node.id);
                const outgoing = definition.edges.filter(e => e.source === node.id);
                if (incoming.length === 0) {
                    errors.push(`Task '${node.name}' has no incoming connections`);
                }
                if (outgoing.length === 0) {
                    errors.push(`Task '${node.name}' has no outgoing connections`);
                }
            }
            // Gateway specific validation
            if (node.type === 'exclusiveGateway') {
                const outgoing = definition.edges.filter(e => e.source === node.id);
                if (outgoing.length < 2) {
                    errors.push(`Exclusive gateway '${node.name}' must have at least 2 outgoing flows`);
                }
                // Check for default flow
                const hasDefault = outgoing.some(e => e.type === 'default');
                const hasConditions = outgoing.some(e => e.condition);
                if (hasConditions && !hasDefault) {
                    errors.push(`Exclusive gateway '${node.name}' with conditional flows must have a default flow`);
                }
            }
            if (node.type === 'parallelGateway') {
                const incoming = definition.edges.filter(e => e.target === node.id);
                const outgoing = definition.edges.filter(e => e.source === node.id);
                if (incoming.length > 1 && outgoing.length > 1) {
                    errors.push(`Parallel gateway '${node.name}' cannot be both split and join`);
                }
            }
        }
        // Check for unreachable nodes
        const reachableNodes = new Set();
        const startEventIds = startEvents.map(n => n.id);
        const traverse = (nodeId) => {
            if (reachableNodes.has(nodeId))
                return;
            reachableNodes.add(nodeId);
            const outgoing = definition.edges.filter(e => e.source === nodeId);
            for (const edge of outgoing) {
                traverse(edge.target);
            }
        };
        for (const startId of startEventIds) {
            traverse(startId);
        }
        for (const node of definition.nodes) {
            if (!reachableNodes.has(node.id)) {
                errors.push(`Node '${node.name}' is not reachable from start events`);
            }
        }
        return {
            valid: errors.length === 0,
            errors
        };
    }
    /**
     * Convert visual definition to BPMN XML
     */
    convertToBPMN(definition) {
        const processId = `process_${definition.id || uuidv4().replace(/-/g, '_')}`;
        let bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             targetNamespace="http://metasheet.com/bpmn"
             id="Definitions_${definition.id}">

  <process id="${processId}" name="${definition.name}" isExecutable="true">\n`;
        // Add nodes
        for (const node of definition.nodes) {
            bpmn += this.nodeToXML(node, definition.edges);
        }
        // Add edges
        for (const edge of definition.edges) {
            bpmn += `    <sequenceFlow id="${edge.id}" sourceRef="${edge.source}" targetRef="${edge.target}"`;
            if (edge.condition && edge.type !== 'default') {
                bpmn += `>\n      <conditionExpression>\${${edge.condition}}</conditionExpression>\n    </sequenceFlow>\n`;
            }
            else {
                bpmn += '/>\n';
            }
        }
        bpmn += `  </process>

  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${processId}">\n`;
        // Add visual elements
        for (const node of definition.nodes) {
            bpmn += `      <bpmndi:BPMNShape id="BPMNShape_${node.id}" bpmnElement="${node.id}">
        <dc:Bounds x="${node.position.x}" y="${node.position.y}" width="100" height="80" />
      </bpmndi:BPMNShape>\n`;
        }
        for (const edge of definition.edges) {
            const sourceNode = definition.nodes.find(n => n.id === edge.source);
            const targetNode = definition.nodes.find(n => n.id === edge.target);
            bpmn += `      <bpmndi:BPMNEdge id="BPMNEdge_${edge.id}" bpmnElement="${edge.id}">
        <di:waypoint x="${sourceNode.position.x + 100}" y="${sourceNode.position.y + 40}" />
        <di:waypoint x="${targetNode.position.x}" y="${targetNode.position.y + 40}" />
      </bpmndi:BPMNEdge>\n`;
        }
        bpmn += `    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;
        return bpmn;
    }
    /**
     * Convert node to BPMN XML
     */
    nodeToXML(node, edges) {
        const incoming = edges.filter(e => e.target === node.id).map(e => e.id);
        const outgoing = edges.filter(e => e.source === node.id).map(e => e.id);
        let xml = '';
        switch (node.type) {
            case 'startEvent':
                xml = `    <startEvent id="${node.id}" name="${node.name}">\n`;
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                xml += `    </startEvent>\n`;
                break;
            case 'endEvent':
                xml = `    <endEvent id="${node.id}" name="${node.name}">\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                xml += `    </endEvent>\n`;
                break;
            case 'userTask':
                xml = `    <userTask id="${node.id}" name="${node.name}"`;
                if (node.data.assignee)
                    xml += ` assignee="${node.data.assignee}"`;
                if (node.data.formKey)
                    xml += ` formKey="${node.data.formKey}"`;
                xml += `>\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                if (node.data.candidateUsers?.length) {
                    xml += `      <potentialOwner>\n        <resourceAssignmentExpression>\n          <formalExpression>${node.data.candidateUsers.join(',')}</formalExpression>\n        </resourceAssignmentExpression>\n      </potentialOwner>\n`;
                }
                xml += `    </userTask>\n`;
                break;
            case 'serviceTask':
                xml = `    <serviceTask id="${node.id}" name="${node.name}"`;
                if (node.data.serviceClass)
                    xml += ` implementation="${node.data.serviceClass}"`;
                xml += `>\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                xml += `    </serviceTask>\n`;
                break;
            case 'scriptTask':
                xml = `    <scriptTask id="${node.id}" name="${node.name}" scriptFormat="javascript">\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                if (node.data.script) {
                    xml += `      <script><![CDATA[${node.data.script}]]></script>\n`;
                }
                xml += `    </scriptTask>\n`;
                break;
            case 'exclusiveGateway':
                xml = `    <exclusiveGateway id="${node.id}" name="${node.name}">\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                xml += `    </exclusiveGateway>\n`;
                break;
            case 'parallelGateway':
                xml = `    <parallelGateway id="${node.id}" name="${node.name}">\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                xml += `    </parallelGateway>\n`;
                break;
            case 'intermediateCatchEvent':
                xml = `    <intermediateCatchEvent id="${node.id}" name="${node.name}">\n`;
                if (incoming.length > 0) {
                    xml += incoming.map(id => `      <incoming>${id}</incoming>`).join('\n') + '\n';
                }
                if (outgoing.length > 0) {
                    xml += outgoing.map(id => `      <outgoing>${id}</outgoing>`).join('\n') + '\n';
                }
                // Add event definitions
                if (node.data.timerDefinition) {
                    xml += `      <timerEventDefinition>\n        <timeDuration>${node.data.timerDefinition.value}</timeDuration>\n      </timerEventDefinition>\n`;
                }
                if (node.data.messageRef) {
                    xml += `      <messageEventDefinition messageRef="${node.data.messageRef}" />\n`;
                }
                if (node.data.signalRef) {
                    xml += `      <signalEventDefinition signalRef="${node.data.signalRef}" />\n`;
                }
                xml += `    </intermediateCatchEvent>\n`;
                break;
        }
        return xml;
    }
    /**
     * Deploy workflow to engine
     */
    async deployWorkflow(workflowId) {
        const workflow = await this.loadWorkflow(workflowId);
        if (!workflow) {
            throw new Error('Workflow not found');
        }
        // Validate before deployment
        const validation = this.validateWorkflow(workflow);
        if (!validation.valid) {
            throw new Error(`Workflow validation failed: ${validation.errors.join(', ')}`);
        }
        // Convert to BPMN and deploy via workflow engine
        const bpmnXml = this.convertToBPMN(workflow);
        // Here you would integrate with BPMNWorkflowEngine
        // const engine = new BPMNWorkflowEngine()
        // return await engine.deployProcess({
        //   key: workflow.id!,
        //   name: workflow.name,
        //   description: workflow.description,
        //   bpmnXml,
        //   category: workflow.category
        // })
        this.emit('workflow:deployed', { workflowId, name: workflow.name });
        this.logger.info(`Deployed workflow: ${workflow.name}`);
        return workflowId;
    }
}
export default WorkflowDesigner;
//# sourceMappingURL=WorkflowDesigner.js.map