/**
 * Multitable automation send_email smoke E2E.
 *
 * Closes the final RC TODO smoke item `Smoke test automation
 * send_email save/execute path`. Forks the formula-smoke template
 * (PR #1424) and consumes the shared multitable-helpers module.
 *
 * Three cases:
 *   1. Save a record.created → send_email rule, create a record, poll
 *      the automation execution log, and assert the executed step's
 *      shape end-to-end (status, actionType, output.recipientCount,
 *      output.notificationStatus). Exercises the real event chain
 *      (eventBus → automation executor → NotificationService → mock
 *      email channel) rather than the /test endpoint.
 *   2. POST /automations with a send_email actionConfig missing
 *      `recipients` → 400 + VALIDATION_ERROR + the specific error
 *      message from validateSendEmailConfig.
 *   3. POST /automations with a send_email actionConfig missing
 *      `subjectTemplate` → 400 + VALIDATION_ERROR + the specific
 *      error message.
 *
 * The default EmailNotificationChannel mocks the actual SMTP send
 * (logs + setTimeout); the smoke does not require a real mail server.
 *
 * The /logs endpoint is a flat shape `{ executions: AutomationExecution[] }`,
 * not the standard `{ ok, data }` envelope, so it is read with a
 * direct `request.get` rather than the helper module's `AuthClient.get`.
 *
 * Prerequisites: Metasheet backend (:7778) and frontend (:8899) running
 * locally. Tests skip if either server is unreachable.
 *
 * Run:
 *   cd packages/core-backend
 *   npx playwright test --config tests/e2e/playwright.config.ts \
 *     multitable-automation-send-email-smoke.spec.ts
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import {
  API_BASE_URL,
  createBase,
  createField,
  createRecord,
  createSheet,
  createView,
  ensureServersReachable,
  loginAsPhase0,
  makeAuthClient,
  uniqueLabel,
  type AuthClient,
  type Entity,
} from './multitable-helpers'

let token = ''

test.beforeAll(async ({ request }) => {
  await ensureServersReachable(request)
  token = await loginAsPhase0(request)
})

type AutomationStep = {
  actionType?: string
  status?: string
  output?: Record<string, unknown>
  error?: string
}

type AutomationExecution = {
  id?: string
  status?: string
  ruleId?: string
  steps?: AutomationStep[]
  startedAt?: string
  finishedAt?: string
}

async function setupSheet(client: AuthClient, label: string): Promise<{
  sheet: Entity
  title: Entity
  owner: Entity
  view: Entity
}> {
  const base = await createBase(client, `${label}-base`)
  const sheet = await createSheet(client, base.id, `${label}-sheet`)
  const title = await createField(client, sheet.id, 'Title', 'string')
  const owner = await createField(client, sheet.id, 'Owner', 'string')
  const view = await createView(client, sheet.id, 'Default Grid', 'grid')
  return { sheet, title, owner, view }
}

async function pollForFirstExecution(
  request: APIRequestContext,
  authToken: string,
  sheetId: string,
  ruleId: string,
  timeoutMs = 12000,
  intervalMs = 1000,
): Promise<AutomationExecution> {
  const deadline = Date.now() + timeoutMs
  let lastBodyForError: unknown = null
  while (Date.now() < deadline) {
    const res = await request.get(
      `${API_BASE_URL}/api/multitable/sheets/${sheetId}/automations/${ruleId}/logs?limit=10`,
      { headers: { Authorization: `Bearer ${authToken}` } },
    )
    if (res.ok()) {
      const body = (await res.json()) as { executions?: AutomationExecution[] }
      lastBodyForError = body
      const execution = body.executions?.[0]
      if (execution) return execution
    } else {
      lastBodyForError = { status: res.status() }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`No automation execution observed within ${timeoutMs}ms; last body: ${JSON.stringify(lastBodyForError)}`)
}

test.describe('Multitable automation send_email smoke', () => {
  test.setTimeout(60_000)

  test('record.created → send_email rule executes via NotificationService email channel', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const label = uniqueLabel('a-email-happy')
    const { sheet, title, owner } = await setupSheet(client, label)

    const recipients = ['team@test.local', 'lead@test.local']
    const ruleEnv = await client.post<{ rule: Entity }>(`/api/multitable/sheets/${sheet.id}/automations`, {
      name: `${label}-rule`,
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_email',
      actionConfig: {
        recipients,
        subjectTemplate: `[smoke] new record {{recordId}}`,
        bodyTemplate: `Title={{record.${title.id}}} Owner={{record.${owner.id}}}`,
      },
      enabled: true,
    })
    const rule = ruleEnv.data?.rule
    expect(rule?.id).toBeTruthy()

    // Real event chain: creating a record fires record.created → automation
    // executor enqueues → NotificationService.send → EmailNotificationChannel
    // mock returns { status: 'sent' }. We do NOT call the /test endpoint.
    const created = await createRecord(client, sheet.id, {
      [title.id]: 'Smoke send_email task',
      [owner.id]: 'Alice',
    })
    expect(created.id).toBeTruthy()

    const execution = await pollForFirstExecution(request, token, sheet.id, rule!.id)

    expect(execution.status).toBe('success')
    expect(Array.isArray(execution.steps)).toBe(true)
    const step = execution.steps?.[0]
    expect(step?.actionType).toBe('send_email')
    expect(step?.status).toBe('success')
    expect(step?.output?.recipientCount).toBe(recipients.length)
    expect(step?.output?.notificationStatus).toBe('sent')
  })

  test('rejects send_email rule create when recipients is missing (VALIDATION_ERROR)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const label = uniqueLabel('a-email-no-recipients')
    const { sheet } = await setupSheet(client, label)

    const fail = await client.postExpectingFailure(`/api/multitable/sheets/${sheet.id}/automations`, {
      name: `${label}-rule`,
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_email',
      actionConfig: {
        recipients: [],
        subjectTemplate: 'subject only',
        bodyTemplate: 'body only',
      },
      enabled: true,
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('VALIDATION_ERROR')
    expect(fail.body?.error?.message).toBe('send_email requires at least one recipient')
  })

  test('rejects send_email rule create when subjectTemplate is missing (VALIDATION_ERROR)', async ({ request }) => {
    const client = makeAuthClient(request, token)
    const label = uniqueLabel('a-email-no-subject')
    const { sheet } = await setupSheet(client, label)

    const fail = await client.postExpectingFailure(`/api/multitable/sheets/${sheet.id}/automations`, {
      name: `${label}-rule`,
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_email',
      actionConfig: {
        recipients: ['only@test.local'],
        subjectTemplate: '',
        bodyTemplate: 'body only',
      },
      enabled: true,
    })
    expect(fail.status).toBe(400)
    expect(fail.body?.error?.code).toBe('VALIDATION_ERROR')
    expect(fail.body?.error?.message).toBe('send_email subjectTemplate is required')
  })
})
