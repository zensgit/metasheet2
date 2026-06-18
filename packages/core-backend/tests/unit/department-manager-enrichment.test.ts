import { describe, expect, it, vi } from 'vitest'
import {
  normalizeDeptManagerList,
  mergeDeptManagerIntoRaw,
  resolveManagerListForDept,
  enrichDepartmentsWithManagers,
} from '../../src/directory/department-manager-enrichment'
import type { DingTalkDepartment } from '../../src/integrations/dingtalk/client'

const dept = (id: string, source: Record<string, unknown> = {}): DingTalkDepartment =>
  ({ id, parentId: null, name: id, order: 0, source })

describe('department-manager-enrichment', () => {
  describe('normalizeDeptManagerList', () => {
    it('parses DingTalk comma-string and array, dropping blanks', () => {
      expect(normalizeDeptManagerList('u1,u2 , ,u3')).toEqual(['u1', 'u2', 'u3'])
      expect(normalizeDeptManagerList(['u1', '', 'u2'])).toEqual(['u1', 'u2'])
      expect(normalizeDeptManagerList(null)).toEqual([])
      expect(normalizeDeptManagerList(undefined)).toEqual([])
    })
  })

  describe('mergeDeptManagerIntoRaw', () => {
    it('adds dept_manager_userid_list without overwriting listsub keys', () => {
      expect(mergeDeptManagerIntoRaw({ name: 'Eng', dept_id: 5 }, ['m1'])).toEqual({
        name: 'Eng', dept_id: 5, dept_manager_userid_list: ['m1'],
      })
    })
    it('writes [] for success-empty (authoritative)', () => {
      expect(mergeDeptManagerIntoRaw({ name: 'Eng' }, [])).toEqual({ name: 'Eng', dept_manager_userid_list: [] })
    })
    it('leaves listsub-only when managerList is undefined (failure + no prior)', () => {
      expect(mergeDeptManagerIntoRaw({ name: 'Eng' }, undefined)).toEqual({ name: 'Eng' })
    })
  })

  describe('resolveManagerListForDept (carry-forward)', () => {
    it('uses fresh when defined — and success-empty is authoritative, NOT carried over', () => {
      expect(resolveManagerListForDept(['m1'], ['prior'])).toEqual(['m1'])
      expect(resolveManagerListForDept([], ['prior'])).toEqual([])
    })
    it('carries the prior forward when fresh is undefined (failure); omits when no prior', () => {
      expect(resolveManagerListForDept(undefined, ['prior'])).toEqual(['prior'])
      expect(resolveManagerListForDept(undefined, undefined)).toBeUndefined()
    })
  })

  // THE SEAM — the catch-block correctness the whole carry-forward depends on.
  describe('enrichDepartmentsWithManagers', () => {
    it('success sets managerUserIds (incl. an empty list); a FAILURE leaves it undefined (distinct from success-empty)', async () => {
      const ok = dept('d-ok')
      const empty = dept('d-empty')
      const failed = dept('d-failed')
      const onError = vi.fn()
      const fetchDetail = async (id: string) => {
        if (id === 'd-ok') return { deptManagerUserIdList: ['m1', 'm2'] }
        if (id === 'd-empty') return { deptManagerUserIdList: [] }
        throw new Error('429 rate limited')
      }

      await enrichDepartmentsWithManagers([ok, empty, failed], fetchDetail, onError)

      expect(ok.managerUserIds).toEqual(['m1', 'm2'])
      expect(empty.managerUserIds).toEqual([]) // success-empty → [] (authoritative)
      expect(failed.managerUserIds).toBeUndefined() // failure → undefined, NOT [] — so prior carries forward
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith('d-failed', expect.any(Error))
    })

    it('a per-department failure never throws and never aborts the remaining departments', async () => {
      const a = dept('a')
      const b = dept('b')
      const fetchDetail = async (id: string) => {
        if (id === 'a') throw new Error('boom')
        return { deptManagerUserIdList: ['mb'] }
      }

      await expect(enrichDepartmentsWithManagers([a, b], fetchDetail)).resolves.toBeUndefined()
      expect(a.managerUserIds).toBeUndefined()
      expect(b.managerUserIds).toEqual(['mb']) // b still processed after a failed
    })
  })
})
