/**
 * Backchannel client for the native managed-login provider.
 * Public browser navigation stays in the flow. This module never logs secrets.
 */
import { parseNativeSnapshotShareExport, snapshotShareTargetSchema, type SnapshotShareAuthority, type SnapshotShareTarget } from './plm-managed-snapshot-share-wire'
import { MANAGED_EXCHANGE_ABORT_SECONDS, ManagedCompanionRefusal, type ManagedClientRegistration } from './plm-managed-companion'

export type NativeExchange = {
  subject: string
  tenant_id: string
  org_id: string
  client_id: string
  issuer: string
  scope: string
  delegation_id: string
  expires_in: number
  credential: string
  root_part_id: string
  client_origin: string
}

export type NativeStatus = {
  active: boolean
  subject: string
  tenant_id: string
  org_id: string
  client_id: string
  issuer: string
  scope: string
  delegation_id: string
  expires_in: number
  root_part_id: string
  client_origin: string
}

type FetchImpl = typeof fetch
let fetchOverride: FetchImpl | null = null

export function setManagedNativeFetchForTests(next: FetchImpl | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ManagedCompanionRefusal(500, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
  }
  if (next && process.env.PLM_MANAGED_COMPANION_TEST_HOOKS !== 'true') {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
  }
  fetchOverride = next
}

function caller(): FetchImpl {
  return fetchOverride ?? fetch
}

function headersFor(registration: ManagedClientRegistration): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': registration.nativeTenantId,
    'x-org-id': registration.nativeOrgId,
  }
}

async function postJson(url: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<Response> {
  return caller()(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(MANAGED_EXCHANGE_ABORT_SECONDS * 1000),
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export async function nativeExchange(
  registration: ManagedClientRegistration,
  input: { code: string; codeVerifier: string },
): Promise<NativeExchange> {
  const response = await postJson(
    `${registration.nativeBaseUrl}/api/v1/auth/managed-login/exchange`,
    {
      client_id: registration.clientId,
      client_secret: registration.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      callback: registration.callback,
    },
    headersFor(registration),
  )
  if (!response.ok) throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_EXCHANGE_REFUSED')
  const body = asRecord(await response.json())
  if (!body) throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_EXCHANGE_REFUSED')
  const expiresIn = body.expires_in
  const credential = body.credential
  if (typeof credential !== 'string' || !credential.startsWith('yur_')) {
    throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_EXCHANGE_REFUSED')
  }
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 600) {
    throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_EXCHANGE_REFUSED')
  }
  const text = (key: string): string => {
    const value = body[key]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_EXCHANGE_REFUSED')
    }
    return value
  }
  return {
    subject: text('subject'),
    tenant_id: text('tenant_id'),
    org_id: text('org_id'),
    client_id: text('client_id'),
    issuer: text('issuer'),
    scope: text('scope'),
    delegation_id: text('delegation_id'),
    expires_in: expiresIn,
    credential,
    root_part_id: text('root_part_id'),
    client_origin: text('client_origin'),
  }
}

export async function nativeStatus(
  registration: ManagedClientRegistration,
  delegationId: string,
): Promise<NativeStatus | null> {
  const response = await postJson(
    `${registration.nativeBaseUrl}/api/v1/auth/managed-login/status`,
    {
      client_id: registration.clientId,
      client_secret: registration.clientSecret,
      delegation_id: delegationId,
    },
    headersFor(registration),
  )
  if (!response.ok) return null
  const body = asRecord(await response.json())
  if (!body || body.active !== true) return null
  const text = (key: string): string | null => (typeof body[key] === 'string' ? body[key] as string : null)
  const subject = text('subject')
  const root = text('root_part_id')
  const origin = text('client_origin')
  const scope = text('scope')
  const delegation = text('delegation_id')
  const clientId = text('client_id')
  const issuer = text('issuer')
  const tenant = text('tenant_id')
  const org = text('org_id')
  const expiresIn = body.expires_in
  if (!subject || !root || !origin || !scope || !delegation || !clientId || !issuer || !tenant || !org) return null
  if (typeof expiresIn !== 'number') return null
  return {
    active: true,
    subject,
    tenant_id: tenant,
    org_id: org,
    client_id: clientId,
    issuer,
    scope,
    delegation_id: delegation,
    expires_in: expiresIn,
    root_part_id: root,
    client_origin: origin,
  }
}

export async function nativeRevoke(
  registration: ManagedClientRegistration,
  delegationId: string,
): Promise<boolean> {
  const response = await postJson(
    `${registration.nativeBaseUrl}/api/v1/auth/managed-login/revoke`,
    {
      client_id: registration.clientId,
      client_secret: registration.clientSecret,
      delegation_id: delegationId,
    },
    headersFor(registration),
  )
  return response.status === 204
}

export async function nativeManagedContext(
  registration: ManagedClientRegistration,
  credential: string,
  partId: string,
): Promise<unknown> {
  if (!credential.startsWith('yur_')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  const response = await caller()(
    `${registration.nativeBaseUrl}/api/v1/bom/multitable/${encodeURIComponent(partId)}/managed-context`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credential}`,
        'x-tenant-id': registration.nativeTenantId,
        'x-org-id': registration.nativeOrgId,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(MANAGED_EXCHANGE_ABORT_SECONDS * 1000),
    },
  )
  if (!response.ok) throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_READ_REFUSED')
  return response.json()
}


/** Separate purpose: preparing a snapshot never consumes a personal read grant. */
export async function nativePrepareSnapshotShare(
  registration: ManagedClientRegistration,
  input: { operationId: string; nativeUserId: number; rootPartId: string; target: SnapshotShareTarget; state: string; codeChallenge: string },
): Promise<{ intentId: string; operationId: string; navigationUrl: string }> {
  if (!Number.isSafeInteger(input.nativeUserId) || input.nativeUserId < 1) {
    throw new ManagedCompanionRefusal(403, 'PLM_SNAPSHOT_SHARE_IDENTITY_REFUSED')
  }
  const target = snapshotShareTargetSchema.parse(input.target)
  const response = await postJson(`${registration.nativeBaseUrl}/api/v1/auth/bom-snapshot-share/prepare`, {
    client_id: registration.clientId, client_secret: registration.clientSecret, callback: registration.callback,
    operation_id: input.operationId, native_user_id: input.nativeUserId, root_part_id: input.rootPartId,
    target, state: input.state, code_challenge: input.codeChallenge, code_challenge_method: 'S256',
  }, headersFor(registration))
  if (!response.ok) throw new ManagedCompanionRefusal(502, 'PLM_SNAPSHOT_SHARE_PREPARE_REFUSED')
  const body = asRecord(await response.json())
  const intentId = body?.intent_id
  if (typeof intentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intentId)
      || body?.operation_id !== input.operationId || body?.policy !== 'authorized_snapshot_target_acl.v1'
      || body?.confirmation_path !== `/bom-snapshot-share?intent=${intentId}`) {
    throw new ManagedCompanionRefusal(502, 'PLM_SNAPSHOT_SHARE_PREPARE_REFUSED')
  }
  return { intentId, operationId: input.operationId, navigationUrl: `${registration.nativeBaseUrl}${body.confirmation_path}` }
}

export async function nativeExportSnapshotShare(
  registration: ManagedClientRegistration,
  input: { code: string; codeVerifier: string },
  authority: SnapshotShareAuthority,
): Promise<ReturnType<typeof parseNativeSnapshotShareExport>> {
  if (!/^yus_[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(input.code)) {
    throw new ManagedCompanionRefusal(403, 'PLM_SNAPSHOT_SHARE_PURPOSE_REFUSED')
  }
  const response = await postJson(`${registration.nativeBaseUrl}/api/v1/auth/bom-snapshot-share/export`, {
    client_id: registration.clientId, client_secret: registration.clientSecret, callback: registration.callback,
    code: input.code, code_verifier: input.codeVerifier,
  }, headersFor(registration))
  if (!response.ok) throw new ManagedCompanionRefusal(502, 'PLM_SNAPSHOT_SHARE_EXPORT_REFUSED')
  return parseNativeSnapshotShareExport(await response.json(), authority)
}

/** Cleanup uses the preparing client, including when new issuance is disabled. */
export async function nativeCancelSnapshotShare(
  registration: ManagedClientRegistration,
  input: { intentId: string; operationId: string },
): Promise<void> {
  const response = await postJson(`${registration.nativeBaseUrl}/api/v1/auth/bom-snapshot-share/cancel`, {
    client_id: registration.clientId, client_secret: registration.clientSecret, callback: registration.callback,
    intent_id: input.intentId, operation_id: input.operationId,
  }, headersFor(registration))
  if (!response.ok || asRecord(await response.json())?.revoked !== true) {
    throw new ManagedCompanionRefusal(502, 'PLM_SNAPSHOT_SHARE_CANCEL_REFUSED')
  }
}
