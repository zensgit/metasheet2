"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const zod_1 = require("zod");
const router = (0, express_1.Router)();
// Workflow schema validation
const WorkflowNodeSchema = zod_1.z.object({
    id: zod_1.z.string(),
    type: zod_1.z.string(),
    position: zod_1.z.object({
        x: zod_1.z.number(),
        y: zod_1.z.number()
    }),
    data: zod_1.z.record(zod_1.z.any())
});
const WorkflowEdgeSchema = zod_1.z.object({
    id: zod_1.z.string(),
    source: zod_1.z.string(),
    target: zod_1.z.string(),
    sourceHandle: zod_1.z.string().optional(),
    targetHandle: zod_1.z.string().optional(),
    type: zod_1.z.string().optional(),
    data: zod_1.z.record(zod_1.z.any()).optional()
});
const WorkflowDefinitionSchema = zod_1.z.object({
    name: zod_1.z.string(),
    description: zod_1.z.string().optional(),
    nodes: zod_1.z.array(WorkflowNodeSchema),
    edges: zod_1.z.array(WorkflowEdgeSchema),
    variables: zod_1.z.record(zod_1.z.any()).optional(),
    settings: zod_1.z.object({
        maxExecutionTime: zod_1.z.number().optional(),
        retryPolicy: zod_1.z.object({
            enabled: zod_1.z.boolean(),
            maxRetries: zod_1.z.number(),
            retryDelay: zod_1.z.number()
        }).optional(),
        errorHandling: zod_1.z.enum(['fail', 'continue', 'compensate']).optional()
    }).optional()
});
// List all workflows
router.get('/workflows', auth_1.authMiddleware, async (req, res) => {
    try {
        const { status, category, search, limit = 20, offset = 0 } = req.query;
        let query = db_1.db
            .selectFrom('workflow_definitions')
            .selectAll()
            .where('deleted_at', 'is', null)
            .orderBy('created_at', 'desc');
        if (status) {
            query = query.where('status', '=', status);
        }
        if (category) {
            query = query.where('category', '=', category);
        }
        if (search) {
            query = query.where((eb) => eb.or([
                eb('name', 'ilike', `%${search}%`),
                eb('description', 'ilike', `%${search}%`)
            ]));
        }
        const workflows = await query
            .limit(Number(limit))
            .offset(Number(offset))
            .execute();
        const total = await db_1.db
            .selectFrom('workflow_definitions')
            .select(db_1.db.fn.count('id').as('count'))
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
        res.json({
            workflows,
            total: total?.count || 0,
            limit: Number(limit),
            offset: Number(offset)
        });
    }
    catch (error) {
        console.error('Error fetching workflows:', error);
        res.status(500).json({ error: 'Failed to fetch workflows' });
    }
});
// Get single workflow
router.get('/workflows/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const workflow = await db_1.db
            .selectFrom('workflow_definitions')
            .selectAll()
            .where('id', '=', req.params.id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found' });
        }
        // Get workflow statistics
        const stats = await db_1.db
            .selectFrom('workflow_instances')
            .select([
            db_1.db.fn.count('id').as('total_instances'),
            db_1.db.fn.countAll().filter((eb) => eb('status', '=', 'completed')).as('completed'),
            db_1.db.fn.countAll().filter((eb) => eb('status', '=', 'failed')).as('failed'),
            db_1.db.fn.countAll().filter((eb) => eb('status', '=', 'running')).as('running')
        ])
            .where('workflow_id', '=', req.params.id)
            .executeTakeFirst();
        res.json({
            ...workflow,
            stats
        });
    }
    catch (error) {
        console.error('Error fetching workflow:', error);
        res.status(500).json({ error: 'Failed to fetch workflow' });
    }
});
// Create new workflow
router.post('/workflows', auth_1.authMiddleware, async (req, res) => {
    try {
        const validatedData = WorkflowDefinitionSchema.parse(req.body);
        const userId = req.user.id;
        const workflow = await db_1.db
            .insertInto('workflow_definitions')
            .values({
            id: `wf_${Date.now()}`,
            name: validatedData.name,
            description: validatedData.description,
            definition: JSON.stringify({
                nodes: validatedData.nodes,
                edges: validatedData.edges
            }),
            variables: JSON.stringify(validatedData.variables || {}),
            settings: JSON.stringify(validatedData.settings || {}),
            status: 'draft',
            version: 1,
            created_by: userId,
            created_at: new Date(),
            updated_at: new Date()
        })
            .returningAll()
            .executeTakeFirst();
        res.status(201).json(workflow);
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: 'Invalid workflow data', details: error.errors });
        }
        console.error('Error creating workflow:', error);
        res.status(500).json({ error: 'Failed to create workflow' });
    }
});
// Update workflow
router.put('/workflows/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const validatedData = WorkflowDefinitionSchema.partial().parse(req.body);
        const userId = req.user.id;
        // Check if workflow exists
        const existing = await db_1.db
            .selectFrom('workflow_definitions')
            .select(['id', 'version', 'status'])
            .where('id', '=', req.params.id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
        if (!existing) {
            return res.status(404).json({ error: 'Workflow not found' });
        }
        // Create new version if workflow is published
        if (existing.status === 'published') {
            // Archive current version
            await db_1.db
                .updateTable('workflow_definitions')
                .set({ status: 'archived' })
                .where('id', '=', req.params.id)
                .execute();
            // Create new version
            const newWorkflow = await db_1.db
                .insertInto('workflow_definitions')
                .values({
                id: `wf_${Date.now()}`,
                name: validatedData.name,
                description: validatedData.description,
                definition: JSON.stringify({
                    nodes: validatedData.nodes,
                    edges: validatedData.edges
                }),
                variables: JSON.stringify(validatedData.variables || {}),
                settings: JSON.stringify(validatedData.settings || {}),
                status: 'draft',
                version: existing.version + 1,
                parent_id: existing.id,
                created_by: userId,
                created_at: new Date(),
                updated_at: new Date()
            })
                .returningAll()
                .executeTakeFirst();
            return res.json(newWorkflow);
        }
        // Update existing draft
        const updated = await db_1.db
            .updateTable('workflow_definitions')
            .set({
            name: validatedData.name,
            description: validatedData.description,
            definition: validatedData.nodes && validatedData.edges
                ? JSON.stringify({
                    nodes: validatedData.nodes,
                    edges: validatedData.edges
                })
                : undefined,
            variables: validatedData.variables
                ? JSON.stringify(validatedData.variables)
                : undefined,
            settings: validatedData.settings
                ? JSON.stringify(validatedData.settings)
                : undefined,
            updated_at: new Date(),
            updated_by: userId
        })
            .where('id', '=', req.params.id)
            .returningAll()
            .executeTakeFirst();
        res.json(updated);
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: 'Invalid workflow data', details: error.errors });
        }
        console.error('Error updating workflow:', error);
        res.status(500).json({ error: 'Failed to update workflow' });
    }
});
// Publish workflow
router.post('/workflows/:id/publish', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const workflow = await db_1.db
            .updateTable('workflow_definitions')
            .set({
            status: 'published',
            published_at: new Date(),
            published_by: userId,
            updated_at: new Date()
        })
            .where('id', '=', req.params.id)
            .where('status', '=', 'draft')
            .returningAll()
            .executeTakeFirst();
        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found or already published' });
        }
        res.json(workflow);
    }
    catch (error) {
        console.error('Error publishing workflow:', error);
        res.status(500).json({ error: 'Failed to publish workflow' });
    }
});
// Delete workflow (soft delete)
router.delete('/workflows/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const deleted = await db_1.db
            .updateTable('workflow_definitions')
            .set({
            deleted_at: new Date(),
            deleted_by: userId
        })
            .where('id', '=', req.params.id)
            .where('deleted_at', 'is', null)
            .returningAll()
            .executeTakeFirst();
        if (!deleted) {
            return res.status(404).json({ error: 'Workflow not found' });
        }
        res.json({ message: 'Workflow deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting workflow:', error);
        res.status(500).json({ error: 'Failed to delete workflow' });
    }
});
// Execute workflow
router.post('/workflows/:id/execute', auth_1.authMiddleware, async (req, res) => {
    try {
        const { variables = {}, context = {} } = req.body;
        const userId = req.user.id;
        // Get workflow definition
        const workflow = await db_1.db
            .selectFrom('workflow_definitions')
            .selectAll()
            .where('id', '=', req.params.id)
            .where('status', '=', 'published')
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
        if (!workflow) {
            return res.status(404).json({ error: 'Published workflow not found' });
        }
        // Create workflow instance
        const instance = await db_1.db
            .insertInto('workflow_instances')
            .values({
            id: `wi_${Date.now()}`,
            workflow_id: workflow.id,
            status: 'pending',
            variables: JSON.stringify(variables),
            context: JSON.stringify({
                ...context,
                triggered_by: userId,
                triggered_at: new Date()
            }),
            started_at: new Date(),
            created_at: new Date()
        })
            .returningAll()
            .executeTakeFirst();
        // TODO: Trigger workflow execution via TokenExecutor
        // This would normally be handled by the workflow execution engine
        // For now, we just return the created instance
        res.status(202).json({
            message: 'Workflow execution started',
            instance_id: instance?.id,
            status: 'pending'
        });
    }
    catch (error) {
        console.error('Error executing workflow:', error);
        res.status(500).json({ error: 'Failed to execute workflow' });
    }
});
// Get workflow instances
router.get('/workflows/:id/instances', auth_1.authMiddleware, async (req, res) => {
    try {
        const { status, limit = 20, offset = 0 } = req.query;
        let query = db_1.db
            .selectFrom('workflow_instances')
            .selectAll()
            .where('workflow_id', '=', req.params.id)
            .orderBy('created_at', 'desc');
        if (status) {
            query = query.where('status', '=', status);
        }
        const instances = await query
            .limit(Number(limit))
            .offset(Number(offset))
            .execute();
        res.json(instances);
    }
    catch (error) {
        console.error('Error fetching workflow instances:', error);
        res.status(500).json({ error: 'Failed to fetch workflow instances' });
    }
});
// Get workflow instance details
router.get('/instances/:id', auth_1.authMiddleware, async (req, res) => {
    try {
        const instance = await db_1.db
            .selectFrom('workflow_instances')
            .selectAll()
            .where('id', '=', req.params.id)
            .executeTakeFirst();
        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }
        // Get tokens for this instance
        const tokens = await db_1.db
            .selectFrom('workflow_tokens')
            .selectAll()
            .where('instance_id', '=', req.params.id)
            .orderBy('created_at', 'desc')
            .execute();
        // Get incidents for this instance
        const incidents = await db_1.db
            .selectFrom('workflow_incidents')
            .selectAll()
            .where('instance_id', '=', req.params.id)
            .orderBy('created_at', 'desc')
            .execute();
        res.json({
            ...instance,
            tokens,
            incidents
        });
    }
    catch (error) {
        console.error('Error fetching instance details:', error);
        res.status(500).json({ error: 'Failed to fetch instance details' });
    }
});
// Cancel workflow instance
router.post('/instances/:id/cancel', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const instance = await db_1.db
            .updateTable('workflow_instances')
            .set({
            status: 'cancelled',
            completed_at: new Date(),
            context: db_1.db.raw(`context || '{"cancelled_by": "${userId}", "cancelled_at": "${new Date().toISOString()}"}'::jsonb`)
        })
            .where('id', '=', req.params.id)
            .where('status', 'in', ['pending', 'running'])
            .returningAll()
            .executeTakeFirst();
        if (!instance) {
            return res.status(404).json({ error: 'Active instance not found' });
        }
        // Cancel all active tokens
        await db_1.db
            .updateTable('workflow_tokens')
            .set({
            status: 'cancelled',
            completed_at: new Date()
        })
            .where('instance_id', '=', req.params.id)
            .where('status', 'in', ['waiting', 'active'])
            .execute();
        res.json({
            message: 'Workflow instance cancelled',
            instance
        });
    }
    catch (error) {
        console.error('Error cancelling instance:', error);
        res.status(500).json({ error: 'Failed to cancel instance' });
    }
});
exports.default = router;
//# sourceMappingURL=workflows.js.map