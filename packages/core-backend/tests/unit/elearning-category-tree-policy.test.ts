import { describe, expect, it } from 'vitest'

import {
  createElearningCategoryTree,
  ELEARNING_CATEGORY_NAME_MAX,
  ELEARNING_CATEGORY_TREE_MAX_NODES,
  ElearningCategoryTreePolicyError,
} from '../../src/services/elearning-category-tree-policy'

const SENTINEL = 'secret-category-value'
const ORG = 'org-1'
const ROOT_A = '10000000-0000-4000-8000-000000000001'
const ROOT_B = '10000000-0000-4000-8000-000000000002'
const CHILD_A = '10000000-0000-4000-8000-000000000003'
const CHILD_B = '10000000-0000-4000-8000-000000000004'
const GRANDCHILD = '10000000-0000-4000-8000-000000000005'

function category(
  categoryId: string,
  parentCategoryId: string | null,
  position: number,
  name = `Category ${position}`,
  orgId = ORG,
) {
  return { categoryId, name, orgId, parentCategoryId, position }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected category tree policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCategoryTreePolicyError)
    const policyError = error as ElearningCategoryTreePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning category tree policy', () => {
  it('builds a deterministic deeply immutable multi-level tree', () => {
    const result = createElearningCategoryTree({
      categories: [
        category(CHILD_B, ROOT_A, 2, '  子类 B  '),
        category(ROOT_B, null, 2, '根 B'),
        category(GRANDCHILD, CHILD_A, 1, '孙类'),
        category(CHILD_A.toUpperCase(), ROOT_A.toUpperCase(), 1, '子类 A'),
        category(ROOT_A, null, 1, '根 A'),
      ],
      orgId: ORG,
    })
    expect(result).toEqual({
      orgId: ORG,
      roots: [
        {
          categoryId: ROOT_A,
          children: [
            {
              categoryId: CHILD_A,
              children: [{
                categoryId: GRANDCHILD,
                children: [],
                name: '孙类',
                parentCategoryId: CHILD_A,
                position: 1,
              }],
              name: '子类 A',
              parentCategoryId: ROOT_A,
              position: 1,
            },
            {
              categoryId: CHILD_B,
              children: [],
              name: '子类 B',
              parentCategoryId: ROOT_A,
              position: 2,
            },
          ],
          name: '根 A',
          parentCategoryId: null,
          position: 1,
        },
        {
          categoryId: ROOT_B,
          children: [],
          name: '根 B',
          parentCategoryId: null,
          position: 2,
        },
      ],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.roots)).toBe(true)
    expect(Object.isFrozen(result.roots[0])).toBe(true)
    expect(Object.isFrozen(result.roots[0].children)).toBe(true)
    expect(Object.isFrozen(result.roots[0].children[0].children[0])).toBe(true)
  })

  it('uses category identity as the deterministic sibling tie-breaker', () => {
    const result = createElearningCategoryTree({
      categories: [
        category(ROOT_B, null, 1, 'B'),
        category(ROOT_A, null, 1, 'A'),
      ],
      orgId: ORG,
    })
    expect(result.roots.map((row) => row.categoryId)).toEqual([ROOT_A, ROOT_B])
  })

  it('accepts an empty organization category tree', () => {
    expect(createElearningCategoryTree({ categories: [], orgId: ORG })).toEqual({
      orgId: ORG,
      roots: [],
    })
  })

  it('rejects mixed organizations, missing parents, duplicate ids, self-links, and cycles', () => {
    for (const categories of [
      [category(ROOT_A, null, 1, 'A', 'org-2')],
      [category(CHILD_A, ROOT_A, 1)],
      [category(ROOT_A, null, 1), category(ROOT_A.toUpperCase(), null, 2)],
      [category(ROOT_A, ROOT_A, 1)],
      [category(ROOT_A, CHILD_A, 1), category(CHILD_A, ROOT_A, 1)],
      [
        category(ROOT_A, CHILD_A, 1),
        category(CHILD_A, GRANDCHILD, 1),
        category(GRANDCHILD, ROOT_A, 1),
      ],
    ]) expectCode(() => createElearningCategoryTree({ categories, orgId: ORG }), 'invalid_tree')
  })

  it('rejects invalid tree fields and open category rows values-free', () => {
    for (const row of [
      category('category-1', null, 1),
      category(ROOT_A, 'category-2', 1),
      category(ROOT_A, null, 0),
      category(ROOT_A, null, 1.5),
      category(ROOT_A, null, Number.MAX_SAFE_INTEGER),
      category(ROOT_A, null, 1, ''),
      category(ROOT_A, null, 1, 'x'.repeat(ELEARNING_CATEGORY_NAME_MAX + 1)),
      category(ROOT_A, null, 1, '\ud800'),
      { ...category(ROOT_A, null, 1), extra: SENTINEL },
    ]) expectCode(
      () => createElearningCategoryTree({ categories: [row], orgId: ORG }),
      'invalid_tree',
    )
  })

  it('rejects invalid top-level shapes, sparse/decorated arrays, and oversized snapshots', () => {
    for (const value of [
      null,
      {},
      { categories: [], orgId: ORG, extra: SENTINEL },
      { categories: [], orgId: '' },
      { categories: [], orgId: '\ud800' },
      { categories: {}, orgId: ORG },
    ]) expectCode(() => createElearningCategoryTree(value), 'invalid_input')

    expectCode(
      () => createElearningCategoryTree({ categories: new Array(1), orgId: ORG }),
      'invalid_input',
    )
    const decorated = [category(ROOT_A, null, 1)] as ReturnType<typeof category>[] & {
      secret?: string
    }
    decorated.secret = SENTINEL
    expectCode(
      () => createElearningCategoryTree({ categories: decorated, orgId: ORG }),
      'invalid_input',
    )
    expectCode(() => createElearningCategoryTree({
      categories: new Array(ELEARNING_CATEGORY_TREE_MAX_NODES + 1)
        .fill(category(ROOT_A, null, 1)),
      orgId: ORG,
    }), 'invalid_input')
  })

  it('fails closed on hostile accessors without exposing their values', () => {
    const hostileTree = Object.defineProperty(
      { categories: [], orgId: ORG },
      'categories',
      { enumerable: true, get(): never { throw new Error(SENTINEL) } },
    )
    expectCode(() => createElearningCategoryTree(hostileTree), 'invalid_input')

    const hostileRow = Object.defineProperty(
      category(ROOT_A, null, 1),
      'name',
      { enumerable: true, get(): never { throw new Error(SENTINEL) } },
    )
    expectCode(
      () => createElearningCategoryTree({ categories: [hostileRow], orgId: ORG }),
      'invalid_tree',
    )
  })

  it('does not retain caller objects or recurse through deep input', () => {
    const inputRows = Array.from({ length: 2_000 }, (_, index) => {
      const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const parentId = index === 0
        ? null
        : `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      return category(id, parentId, 1, `Level ${index + 1}`)
    })
    const result = createElearningCategoryTree({ categories: inputRows, orgId: ORG })
    inputRows[0].name = SENTINEL
    inputRows.splice(1)
    expect(result.roots[0].name).toBe('Level 1')

    let depth = 0
    let current = result.roots[0]
    while (current) {
      depth += 1
      current = current.children[0]
    }
    expect(depth).toBe(2_000)
  })
})
