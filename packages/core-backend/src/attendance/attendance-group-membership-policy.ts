import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'

const modulePath = [
  resolve(__dirname, '../../../../plugins/plugin-attendance/lib/attendance-group-membership-policy.cjs'),
  resolve(__dirname, '../../../../../plugins/plugin-attendance/lib/attendance-group-membership-policy.cjs'),
].find(existsSync)

type Member = Readonly<{ groupId: string; userId: string }>
type Transaction = Pick<AttendanceW4TransactionClientV1, 'query'>
const policy = require(modulePath!) as {
  AttendanceGroupMembershipPolicyError: new (...args: unknown[]) => Error & { code: string; status: number }
  assertCanAddMembers(trx: Transaction, orgId: string, members: readonly Member[]): Promise<void>
  prepareAdmission(trx: Transaction, orgId: string, members: readonly Member[]): Promise<void>
  requireAdmission(trx: Transaction, orgId: string, members: readonly Member[]): Promise<void>
}

export const AttendanceGroupMembershipPolicyError = policy.AttendanceGroupMembershipPolicyError
export const assertAttendanceManagementGroupAdmission = policy.assertCanAddMembers
export const prepareAttendanceManagementGroupAdmission = policy.prepareAdmission
export const requireAttendanceManagementGroupAdmission = policy.requireAdmission
