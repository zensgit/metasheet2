export type ScopeMembershipWitness = Readonly<{
  groupId: string
  targetUserId: string
}>

export type ScopePathWitness = Readonly<{
  departmentIds: readonly string[]
  memberships: readonly ScopeMembershipWitness[]
}>

type ScopeQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>

type DepartmentTuple = {
  id: string
  integrationId: string | null
  externalDepartmentId: string | null
  includeChildren: boolean
}

type DepartmentNode = DepartmentTuple & {
  externalParentDepartmentId: string | null
}

const SEED_SQL = `SELECT d.id,
       d.integration_id,
       d.external_department_id,
       bool_or(COALESCE(s.include_children, TRUE)) AS include_children
FROM delegated_role_admin_scopes s
JOIN directory_departments d ON d.id = s.directory_department_id
WHERE s.admin_user_id = $1
  AND s.namespace = ANY($2::text[])
  AND d.is_active = true
GROUP BY d.id, d.integration_id, d.external_department_id`

const CHILD_SQL = `SELECT child.id,
       child.integration_id,
       child.external_department_id,
       child.external_parent_department_id
FROM directory_departments child
WHERE child.is_active = true
  AND child.integration_id = ANY($1::uuid[])`

const LEAF_SQL = `SELECT DISTINCT ad.directory_department_id AS id
FROM directory_account_links l
JOIN directory_accounts a
  ON a.id = l.directory_account_id
 AND a.is_active = true
JOIN directory_account_departments ad
  ON ad.directory_account_id = a.id
WHERE l.local_user_id = $1
  AND l.link_status = 'linked'`

const GROUP_SQL = `SELECT DISTINCT gscope.group_id
FROM delegated_role_admin_member_groups gscope
JOIN platform_member_group_members gm
  ON gm.group_id = gscope.group_id
 AND gm.user_id = $3
WHERE gscope.admin_user_id = $1
  AND gscope.namespace = ANY($2::text[])`

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function tupleKey(tuple: DepartmentTuple): string {
  return [
    tuple.id,
    tuple.integrationId ?? '',
    tuple.externalDepartmentId ?? '',
    tuple.includeChildren ? '1' : '0',
  ].join('\0')
}

function parentKey(integrationId: string, externalDepartmentId: string): string {
  return `${integrationId}\0${externalDepartmentId}`
}

function readSeed(row: Record<string, unknown>): DepartmentTuple | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null
  return {
    id: row.id,
    integrationId: textOrNull(row.integration_id),
    externalDepartmentId: textOrNull(row.external_department_id),
    includeChildren: row.include_children === true,
  }
}

function readChild(row: Record<string, unknown>): DepartmentNode | null {
  const seed = readSeed(row)
  if (!seed) return null
  return {
    ...seed,
    includeChildren: true,
    externalParentDepartmentId: textOrNull(row.external_parent_department_id),
  }
}

function freezeWitness(departmentIds: readonly string[], memberships: readonly ScopeMembershipWitness[]): ScopePathWitness {
  return Object.freeze({
    departmentIds: Object.freeze([...departmentIds]),
    memberships: Object.freeze(memberships.map((membership) => Object.freeze({
      groupId: membership.groupId,
      targetUserId: membership.targetUserId,
    }))),
  })
}

export function sameScopePathWitness(left: ScopePathWitness, right: ScopePathWitness): boolean {
  if (left.departmentIds.length !== right.departmentIds.length || left.memberships.length !== right.memberships.length) return false
  for (let index = 0; index < left.departmentIds.length; index += 1) {
    if (left.departmentIds[index] !== right.departmentIds[index]) return false
  }
  for (let index = 0; index < left.memberships.length; index += 1) {
    const current = left.memberships[index]
    const next = right.memberships[index]
    if (!current || !next || current.groupId !== next.groupId || current.targetUserId !== next.targetUserId) return false
  }
  return true
}

function successfulDepartmentIds(seeds: readonly DepartmentTuple[], nodes: readonly DepartmentNode[], leafIds: readonly string[]): string[] {
  const tuples = new Map<string, DepartmentTuple>()
  const queue: DepartmentTuple[] = []
  for (const seed of seeds) {
    const key = tupleKey(seed)
    if (tuples.has(key)) continue
    tuples.set(key, seed)
    queue.push(seed)
  }
  const childrenByParent = new Map<string, DepartmentNode[]>()
  for (const node of nodes) {
    if (node.integrationId === null || node.externalParentDepartmentId === null) continue
    const key = parentKey(node.integrationId, node.externalParentDepartmentId)
    const bucket = childrenByParent.get(key)
    if (bucket) bucket.push(node)
    else childrenByParent.set(key, [node])
  }
  const reverse = new Map<string, Set<string>>()
  let cursor = 0
  while (cursor < queue.length) {
    const parent = queue[cursor]
    cursor += 1
    if (!parent || parent.includeChildren !== true || parent.integrationId === null || parent.externalDepartmentId === null) continue
    const children = childrenByParent.get(parentKey(parent.integrationId, parent.externalDepartmentId)) ?? []
    for (const child of children) {
      const parents = reverse.get(child.id)
      if (parents) parents.add(parent.id)
      else reverse.set(child.id, new Set([parent.id]))
      const childTuple: DepartmentTuple = {
        id: child.id,
        integrationId: child.integrationId,
        externalDepartmentId: child.externalDepartmentId,
        includeChildren: true,
      }
      const key = tupleKey(childTuple)
      if (tuples.has(key)) continue
      tuples.set(key, childTuple)
      queue.push(childTuple)
    }
  }
  const reachable = new Set<string>()
  for (const tuple of tuples.values()) reachable.add(tuple.id)
  const onPath = new Set<string>()
  const stack: string[] = []
  for (const leafId of leafIds) if (reachable.has(leafId)) stack.push(leafId)
  while (stack.length > 0) {
    const id = stack.pop()
    if (!id || onPath.has(id)) continue
    onPath.add(id)
    for (const parentId of reverse.get(id) ?? []) {
      if (reachable.has(parentId)) stack.push(parentId)
    }
  }
  return [...onPath].sort(compareCodeUnits)
}

export async function enumerateScopePathWitness(
  query: ScopeQuery,
  actorId: string,
  namespaces: readonly string[],
  targetUserId: string,
): Promise<ScopePathWitness> {
  if (namespaces.length === 0) return freezeWitness([], [])
  const namespaceList = [...namespaces]
  const seedRows = await query(SEED_SQL, [actorId, namespaceList])
  const seeds = seedRows.rows.flatMap((row) => {
    const seed = readSeed(row)
    return seed ? [seed] : []
  })
  const integrationIds = [...new Set(seeds.flatMap((seed) => seed.integrationId === null ? [] : [seed.integrationId]))].sort(compareCodeUnits)
  const childRows = integrationIds.length === 0
    ? { rows: [] as Array<Record<string, unknown>> }
    : await query(CHILD_SQL, [integrationIds])
  const nodes = childRows.rows.flatMap((row) => {
    const child = readChild(row)
    return child ? [child] : []
  })
  const leafRows = seeds.length === 0
    ? { rows: [] as Array<Record<string, unknown>> }
    : await query(LEAF_SQL, [targetUserId])
  const leafIds = leafRows.rows.flatMap((row) => typeof row.id === 'string' && row.id.length > 0 ? [row.id] : [])
  const departmentIds = successfulDepartmentIds(seeds, nodes, leafIds)
  const groupRows = await query(GROUP_SQL, [actorId, namespaceList, targetUserId])
  const groupIds = [...new Set(groupRows.rows.flatMap((row) => typeof row.group_id === 'string' && row.group_id.length > 0 ? [row.group_id] : []))].sort(compareCodeUnits)
  const memberships = groupIds.map((groupId) => ({ groupId, targetUserId }))
  return freezeWitness(departmentIds, memberships)
}
