/**
 * Workflow API Routes
 * RESTful endpoints for BPMN workflow management
 */
import { Router } from 'express';
import { BPMNWorkflowEngine } from '../workflow/BPMNWorkflowEngine';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { body, param, query } from 'express-validator';
import { Logger } from '../core/logger';
import multer from 'multer';
const router = Router();
const logger = new Logger('WorkflowAPI');
const workflowEngine = new BPMNWorkflowEngine();
// File upload for BPMN XML
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});
// Initialize engine
workflowEngine.initialize().catch(error => {
    logger.error('Failed to initialize Workflow Engine:', error);
});
/**
 * POST /api/workflow/deploy
 * Deploy a new process definition
 */
router.post('/deploy', authenticate, upload.single('bpmnFile'), body('key').optional().isString(), body('name').isString().notEmpty(), body('category').optional().isString(), validate, async (req, res) => {
    try {
        let bpmnXml;
        if (req.file) {
            // BPMN file uploaded
            bpmnXml = req.file.buffer.toString('utf-8');
        }
        else if (req.body.bpmnXml) {
            // BPMN XML in body
            bpmnXml = req.body.bpmnXml;
        }
        else {
            return res.status(400).json({
                success: false,
                error: 'BPMN XML required (file upload or bpmnXml field)'
            });
        }
        const definitionId = await workflowEngine.deployProcess({
            key: req.body.key,
            name: req.body.name,
            description: req.body.description,
            category: req.body.category,
            bpmnXml,
            tenantId: req.user?.tenantId
        });
        res.status(201).json({
            success: true,
            data: {
                definitionId,
                message: 'Process deployed successfully'
            }
        });
    }
    catch (error) {
        logger.error('Failed to deploy process:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to deploy process'
        });
    }
});
/**
 * GET /api/workflow/definitions
 * List process definitions
 */
router.get('/definitions', authenticate, query('category').optional().isString(), query('latest').optional().isBoolean(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { category, latest } = req.query;
        const tenantId = req.user?.tenantId;
        let query = db
            .selectFrom('bpmn_process_definitions')
            .selectAll()
            .where('tenant_id', '=', tenantId || null);
        if (category) {
            query = query.where('category', '=', category);
        }
        if (latest === 'true') {
            // Get only latest versions
            query = query
                .distinctOn('key')
                .orderBy('key')
                .orderBy('version', 'desc');
        }
        const definitions = await query.execute();
        res.json({
            success: true,
            data: definitions.map(def => ({
                ...def,
                diagram_json: def.diagram_json ? JSON.parse(def.diagram_json) : null
            }))
        });
    }
    catch (error) {
        logger.error('Failed to list definitions:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list process definitions'
        });
    }
});
/**
 * POST /api/workflow/start/:key
 * Start a process instance
 */
router.post('/start/:key', authenticate, param('key').isString(), body('businessKey').optional().isString(), body('variables').optional().isObject(), validate, async (req, res) => {
    try {
        const { key } = req.params;
        const { businessKey, variables = {} } = req.body;
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        const instanceId = await workflowEngine.startProcess(key, { ...variables, _startUserId: userId }, businessKey, tenantId);
        res.status(201).json({
            success: true,
            data: {
                instanceId,
                message: 'Process started successfully'
            }
        });
    }
    catch (error) {
        logger.error('Failed to start process:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to start process'
        });
    }
});
/**
 * GET /api/workflow/instances
 * List process instances
 */
router.get('/instances', authenticate, query('state').optional().isIn(['ACTIVE', 'SUSPENDED', 'COMPLETED']), query('processKey').optional().isString(), query('businessKey').optional().isString(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { state, processKey, businessKey } = req.query;
        const tenantId = req.user?.tenantId;
        let query = db
            .selectFrom('bpmn_process_instances')
            .selectAll()
            .where('tenant_id', '=', tenantId || null);
        if (state) {
            query = query.where('state', '=', state);
        }
        if (processKey) {
            query = query.where('process_definition_key', '=', processKey);
        }
        if (businessKey) {
            query = query.where('business_key', '=', businessKey);
        }
        const instances = await query
            .orderBy('start_time', 'desc')
            .limit(100)
            .execute();
        res.json({
            success: true,
            data: instances.map(inst => ({
                ...inst,
                variables: inst.variables ? JSON.parse(inst.variables) : {}
            }))
        });
    }
    catch (error) {
        logger.error('Failed to list instances:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list process instances'
        });
    }
});
/**
 * GET /api/workflow/instances/:instanceId
 * Get process instance details
 */
router.get('/instances/:instanceId', authenticate, param('instanceId').isUUID(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { instanceId } = req.params;
        const instance = await db
            .selectFrom('bpmn_process_instances')
            .selectAll()
            .where('id', '=', instanceId)
            .executeTakeFirst();
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Process instance not found'
            });
        }
        // Get activities
        const activities = await db
            .selectFrom('bpmn_activity_instances')
            .selectAll()
            .where('process_instance_id', '=', instanceId)
            .orderBy('start_time', 'asc')
            .execute();
        // Get variables
        const variables = await db
            .selectFrom('bpmn_variables')
            .selectAll()
            .where('process_instance_id', '=', instanceId)
            .execute();
        res.json({
            success: true,
            data: {
                ...instance,
                variables: instance.variables ? JSON.parse(instance.variables) : {},
                activities,
                variableList: variables.map(v => ({
                    ...v,
                    json_value: v.json_value ? JSON.parse(v.json_value) : null
                }))
            }
        });
    }
    catch (error) {
        logger.error('Failed to get instance:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get process instance'
        });
    }
});
/**
 * GET /api/workflow/tasks
 * List user tasks
 */
router.get('/tasks', authenticate, query('assignee').optional().isString(), query('candidateUser').optional().isString(), query('candidateGroup').optional().isString(), query('processInstanceId').optional().isUUID(), query('state').optional().isString(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { assignee, candidateUser, candidateGroup, processInstanceId, state } = req.query;
        const userId = req.user?.id;
        let query = db
            .selectFrom('bpmn_user_tasks')
            .selectAll();
        // Default to user's tasks if no filter
        if (!assignee && !candidateUser && !candidateGroup && !processInstanceId) {
            query = query.where((eb) => eb.or([
                eb('assignee', '=', userId),
                eb('candidate_users', '@>', [userId])
            ]));
        }
        if (assignee) {
            query = query.where('assignee', '=', assignee);
        }
        if (candidateUser) {
            query = query.where('candidate_users', '@>', [candidateUser]);
        }
        if (candidateGroup) {
            query = query.where('candidate_groups', '@>', [candidateGroup]);
        }
        if (processInstanceId) {
            query = query.where('process_instance_id', '=', processInstanceId);
        }
        if (state) {
            query = query.where('state', '=', state);
        }
        else {
            // Default to active tasks
            query = query.where('state', 'not in', ['COMPLETED', 'CANCELLED']);
        }
        const tasks = await query
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute();
        res.json({
            success: true,
            data: tasks.map(task => ({
                ...task,
                variables: task.variables ? JSON.parse(task.variables) : {},
                form_data: task.form_data ? JSON.parse(task.form_data) : null
            }))
        });
    }
    catch (error) {
        logger.error('Failed to list tasks:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list tasks'
        });
    }
});
/**
 * POST /api/workflow/tasks/:taskId/claim
 * Claim a task
 */
router.post('/tasks/:taskId/claim', authenticate, param('taskId').isUUID(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { taskId } = req.params;
        const userId = req.user?.id;
        const task = await db
            .selectFrom('bpmn_user_tasks')
            .select(['state', 'assignee'])
            .where('id', '=', taskId)
            .executeTakeFirst();
        if (!task) {
            return res.status(404).json({
                success: false,
                error: 'Task not found'
            });
        }
        if (task.assignee && task.assignee !== userId) {
            return res.status(409).json({
                success: false,
                error: 'Task already assigned to another user'
            });
        }
        await db
            .updateTable('bpmn_user_tasks')
            .set({
            assignee: userId,
            state: 'RESERVED',
            claimed_at: new Date()
        })
            .where('id', '=', taskId)
            .execute();
        res.json({
            success: true,
            message: 'Task claimed successfully'
        });
    }
    catch (error) {
        logger.error('Failed to claim task:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to claim task'
        });
    }
});
/**
 * POST /api/workflow/tasks/:taskId/complete
 * Complete a task
 */
router.post('/tasks/:taskId/complete', authenticate, param('taskId').isUUID(), body('variables').optional().isObject(), body('formData').optional().isObject(), validate, async (req, res) => {
    try {
        const { taskId } = req.params;
        const { variables = {}, formData } = req.body;
        const userId = req.user?.id;
        // Store form data if provided
        if (formData) {
            const { db } = require('../db/db');
            await db
                .updateTable('bpmn_user_tasks')
                .set({
                form_data: JSON.stringify(formData)
            })
                .where('id', '=', taskId)
                .execute();
        }
        // Complete task
        await workflowEngine.completeUserTask(taskId, variables, userId);
        res.json({
            success: true,
            message: 'Task completed successfully'
        });
    }
    catch (error) {
        logger.error('Failed to complete task:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to complete task'
        });
    }
});
/**
 * POST /api/workflow/message
 * Send a message event
 */
router.post('/message', authenticate, body('messageName').isString().notEmpty(), body('correlationKey').optional().isString(), body('variables').optional().isObject(), validate, async (req, res) => {
    try {
        const { messageName, correlationKey, variables } = req.body;
        await workflowEngine.sendMessage(messageName, correlationKey, variables);
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    }
    catch (error) {
        logger.error('Failed to send message:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send message'
        });
    }
});
/**
 * POST /api/workflow/signal
 * Broadcast a signal event
 */
router.post('/signal', authenticate, body('signalName').isString().notEmpty(), body('variables').optional().isObject(), validate, async (req, res) => {
    try {
        const { signalName, variables } = req.body;
        await workflowEngine.broadcastSignal(signalName, variables);
        res.json({
            success: true,
            message: 'Signal broadcast successfully'
        });
    }
    catch (error) {
        logger.error('Failed to broadcast signal:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to broadcast signal'
        });
    }
});
/**
 * GET /api/workflow/incidents
 * List incidents (errors)
 */
router.get('/incidents', authenticate, query('state').optional().isIn(['OPEN', 'RESOLVED']), query('processInstanceId').optional().isUUID(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { state = 'OPEN', processInstanceId } = req.query;
        let query = db
            .selectFrom('bpmn_incidents')
            .selectAll()
            .where('state', '=', state);
        if (processInstanceId) {
            query = query.where('process_instance_id', '=', processInstanceId);
        }
        const incidents = await query
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute();
        res.json({
            success: true,
            data: incidents
        });
    }
    catch (error) {
        logger.error('Failed to list incidents:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list incidents'
        });
    }
});
/**
 * POST /api/workflow/incidents/:incidentId/resolve
 * Resolve an incident
 */
router.post('/incidents/:incidentId/resolve', authenticate, param('incidentId').isUUID(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { incidentId } = req.params;
        const userId = req.user?.id;
        await db
            .updateTable('bpmn_incidents')
            .set({
            state: 'RESOLVED',
            resolved_at: new Date(),
            resolved_by: userId
        })
            .where('id', '=', incidentId)
            .execute();
        res.json({
            success: true,
            message: 'Incident resolved successfully'
        });
    }
    catch (error) {
        logger.error('Failed to resolve incident:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to resolve incident'
        });
    }
});
/**
 * GET /api/workflow/audit
 * Get audit log
 */
router.get('/audit', authenticate, query('processInstanceId').optional().isUUID(), query('taskId').optional().isUUID(), query('userId').optional().isString(), query('from').optional().isISO8601(), query('to').optional().isISO8601(), validate, async (req, res) => {
    try {
        const { db } = require('../db/db');
        const { processInstanceId, taskId, userId, from, to } = req.query;
        let query = db
            .selectFrom('bpmn_audit_log')
            .selectAll();
        if (processInstanceId) {
            query = query.where('process_instance_id', '=', processInstanceId);
        }
        if (taskId) {
            query = query.where('task_id', '=', taskId);
        }
        if (userId) {
            query = query.where('user_id', '=', userId);
        }
        if (from) {
            query = query.where('timestamp', '>=', new Date(from));
        }
        if (to) {
            query = query.where('timestamp', '<=', new Date(to));
        }
        const logs = await query
            .orderBy('timestamp', 'desc')
            .limit(500)
            .execute();
        res.json({
            success: true,
            data: logs.map(log => ({
                ...log,
                old_value: log.old_value ? JSON.parse(log.old_value) : null,
                new_value: log.new_value ? JSON.parse(log.new_value) : null
            }))
        });
    }
    catch (error) {
        logger.error('Failed to get audit log:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get audit log'
        });
    }
});
// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down workflow engine...');
    await workflowEngine.shutdown();
});
export default router;
//# sourceMappingURL=workflow.js.map