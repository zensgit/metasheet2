/**
 * Pure L1 authority for an organization-scoped course-category tree.
 *
 * Persistence, course references, management scope, routes, UI, and feature
 * flags stay outside this module. Adapters must load one complete org-scoped
 * snapshot before calling this policy; the policy rejects mixed organizations,
 * missing parents, duplicate identities, and cycles before returning a deeply
 * immutable tree.
 */

export const ELEARNING_CATEGORY_NAME_MAX = 120 as const
export const ELEARNING_CATEGORY_TREE_MAX_NODES = 10_000 as const

const ORG_ID_MAX = 256
const PG_INT32_MAX = 2_147_483_647
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TREE_KEYS = ['categories', 'orgId'] as const
const CATEGORY_KEYS = [
  'categoryId',
  'name',
  'orgId',
  'parentCategoryId',
  'position',
] as const

export type ElearningCategoryTreePolicyErrorCode =
  | 'invalid_input'
  | 'invalid_tree'

export class ElearningCategoryTreePolicyError extends Error {
  constructor(readonly code: ElearningCategoryTreePolicyErrorCode) {
    super(code)
    this.name = 'ElearningCategoryTreePolicyError'
  }
}

export interface ElearningCategoryTreeNode {
  readonly categoryId: string
  readonly children: readonly ElearningCategoryTreeNode[]
  readonly name: string
  readonly parentCategoryId: string | null
  readonly position: number
}

export interface ElearningCategoryTreeSnapshot {
  readonly orgId: string
  readonly roots: readonly ElearningCategoryTreeNode[]
}

interface NormalizedCategoryRow {
  readonly categoryId: string
  readonly name: string
  readonly parentCategoryId: string | null
  readonly position: number
}

function fail(code: ElearningCategoryTreePolicyErrorCode): never {
  throw new ElearningCategoryTreePolicyError(code)
}

function readExactObject(
  input: unknown,
  keys: readonly string[],
  code: ElearningCategoryTreePolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const ownKeys = Reflect.ownKeys(input)
    if (ownKeys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (ownKeys as string[]).sort()
    if (
      sorted.length !== keys.length
      || sorted.some((key, index) => key !== keys[index])
    ) fail(code)
    return Object.fromEntries(
      keys.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningCategoryTreePolicyError) throw error
    fail(code)
  }
}

function readDenseArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail('invalid_input')
    const length = input.length
    if (
      length > ELEARNING_CATEGORY_TREE_MAX_NODES
      || Reflect.ownKeys(input).length !== length + 1
    ) fail('invalid_input')
    const values: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail('invalid_input')
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningCategoryTreePolicyError) throw error
    fail('invalid_input')
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) return false
  }
  return true
}

function requireText(
  value: unknown,
  maxLength: number,
  code: ElearningCategoryTreePolicyErrorCode,
): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (
    text === ''
    || text.length > maxLength
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail(code)
  return text
}

function requireUuid(
  value: unknown,
  code: ElearningCategoryTreePolicyErrorCode,
): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value.toLowerCase()
}

function requirePosition(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > PG_INT32_MAX
  ) fail('invalid_tree')
  return value
}

function compareCategory(
  left: NormalizedCategoryRow,
  right: NormalizedCategoryRow,
): number {
  const positionOrder = left.position - right.position
  if (positionOrder !== 0) return positionOrder
  if (left.categoryId < right.categoryId) return -1
  if (left.categoryId > right.categoryId) return 1
  return 0
}

function assertAcyclic(
  rowsById: ReadonlyMap<string, NormalizedCategoryRow>,
): void {
  const resolved = new Set<string>()
  for (const startingId of rowsById.keys()) {
    if (resolved.has(startingId)) continue
    const path: string[] = []
    const inPath = new Set<string>()
    let currentId: string | null = startingId
    while (currentId !== null && !resolved.has(currentId)) {
      if (inPath.has(currentId)) fail('invalid_tree')
      inPath.add(currentId)
      path.push(currentId)
      currentId = rowsById.get(currentId)?.parentCategoryId ?? null
    }
    for (const categoryId of path) resolved.add(categoryId)
  }
}

function buildImmutableTree(
  rowsById: ReadonlyMap<string, NormalizedCategoryRow>,
): readonly ElearningCategoryTreeNode[] {
  const childrenByParent = new Map<string | null, NormalizedCategoryRow[]>()
  for (const row of rowsById.values()) {
    const siblings = childrenByParent.get(row.parentCategoryId) ?? []
    siblings.push(row)
    childrenByParent.set(row.parentCategoryId, siblings)
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareCategory)

  const nodesById = new Map<string, ElearningCategoryTreeNode>()
  const roots = childrenByParent.get(null) ?? []
  const stack: Array<{ expanded: boolean; row: NormalizedCategoryRow }> = roots
    .slice()
    .reverse()
    .map((row) => ({ expanded: false, row }))
  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    if (!frame.expanded) {
      stack.push({ expanded: true, row: frame.row })
      const children = childrenByParent.get(frame.row.categoryId) ?? []
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ expanded: false, row: children[index] })
      }
      continue
    }
    const children = (childrenByParent.get(frame.row.categoryId) ?? [])
      .map((row) => {
        const child = nodesById.get(row.categoryId)
        if (!child) fail('invalid_tree')
        return child
      })
    nodesById.set(frame.row.categoryId, Object.freeze({
      categoryId: frame.row.categoryId,
      children: Object.freeze(children),
      name: frame.row.name,
      parentCategoryId: frame.row.parentCategoryId,
      position: frame.row.position,
    }))
  }
  return Object.freeze(roots.map((row) => {
    const root = nodesById.get(row.categoryId)
    if (!root) fail('invalid_tree')
    return root
  }))
}

export function createElearningCategoryTree(
  input: unknown,
): ElearningCategoryTreeSnapshot {
  const values = readExactObject(input, TREE_KEYS, 'invalid_input')
  const orgId = requireText(values.orgId, ORG_ID_MAX, 'invalid_input')
  const rowsById = new Map<string, NormalizedCategoryRow>()
  for (const inputRow of readDenseArray(values.categories)) {
    const row = readExactObject(inputRow, CATEGORY_KEYS, 'invalid_tree')
    if (requireText(row.orgId, ORG_ID_MAX, 'invalid_tree') !== orgId) {
      fail('invalid_tree')
    }
    const categoryId = requireUuid(row.categoryId, 'invalid_tree')
    if (rowsById.has(categoryId)) fail('invalid_tree')
    rowsById.set(categoryId, Object.freeze({
      categoryId,
      name: requireText(row.name, ELEARNING_CATEGORY_NAME_MAX, 'invalid_tree'),
      parentCategoryId: row.parentCategoryId === null
        ? null
        : requireUuid(row.parentCategoryId, 'invalid_tree'),
      position: requirePosition(row.position),
    }))
  }

  for (const row of rowsById.values()) {
    if (
      row.parentCategoryId === row.categoryId
      || (row.parentCategoryId !== null && !rowsById.has(row.parentCategoryId))
    ) fail('invalid_tree')
  }
  assertAcyclic(rowsById)
  return Object.freeze({
    orgId,
    roots: buildImmutableTree(rowsById),
  })
}
