import { describe, expect, it } from 'vitest'

import {
  isDingTalkMemberGroupRecipientField,
  listDingTalkGroupDestinationFieldPathWarnings,
  listDingTalkPersonMemberGroupRecipientFieldPathWarnings,
} from '../src/multitable/utils/dingtalkRecipientFieldWarnings'

const fields = [
  { id: 'name', type: 'string' },
  { id: 'assigneeUserIds', type: 'user' },
  { id: 'watcherGroupIds', type: 'link', property: { refKind: 'member-group' } },
  { id: 'escalationGroupId', type: 'member-group' },
  { id: 'reviewGroupId', type: 'member_group' },
  { id: 'approvalGroupId', type: 'membergroup' },
]

describe('dingtalk recipient field warnings', () => {
  it('lists dynamic group destination field path warnings from normalized record paths', () => {
    expect(listDingTalkGroupDestinationFieldPathWarnings(
      [
        'record.missingDestinationId',
        'record.assigneeUserIds',
        'record.watcherGroupIds',
        'record.escalationGroupId',
        'record.reviewGroupId',
        'record.approvalGroupId',
        'record.name',
        'assigneeUserIds',
      ].join(',\n'),
      fields,
    )).toEqual([
      'record.missingDestinationId is not a known field in this sheet; DingTalk group messages expect field IDs that resolve to destination IDs.',
      'record.assigneeUserIds is a user field; use DingTalk person recipient fields instead.',
      'record.watcherGroupIds is a member group field; use DingTalk person member-group recipient fields instead.',
      'record.escalationGroupId is a member group field; use DingTalk person member-group recipient fields instead.',
      'record.reviewGroupId is a member group field; use DingTalk person member-group recipient fields instead.',
      'record.approvalGroupId is a member group field; use DingTalk person member-group recipient fields instead.',
    ])
  })

  it('returns no dynamic group destination warnings for empty or non-string input', () => {
    expect(listDingTalkGroupDestinationFieldPathWarnings('', fields)).toEqual([])
    expect(listDingTalkGroupDestinationFieldPathWarnings(['record.assigneeUserIds'], fields)).toEqual([])
  })

  it('lists dynamic person member-group recipient field path warnings from normalized record paths', () => {
    expect(listDingTalkPersonMemberGroupRecipientFieldPathWarnings(
      [
        'record.missingGroupId',
        'record.assigneeUserIds',
        'record.name',
        'record.watcherGroupIds',
        'record.escalationGroupId',
        'record.reviewGroupId',
        'record.approvalGroupId',
        'name',
      ].join(',\n'),
      fields,
    )).toEqual([
      'record.missingGroupId is not a known field in this sheet; DingTalk person member-group recipients expect field IDs that resolve to member group IDs.',
      'record.assigneeUserIds is a user field; use Record recipient field paths instead.',
      'record.name is not a member group field; DingTalk person member-group recipients expect member group fields.',
    ])
  })

  it('returns no person member-group recipient warnings for empty or non-string input', () => {
    expect(listDingTalkPersonMemberGroupRecipientFieldPathWarnings('', fields)).toEqual([])
    expect(listDingTalkPersonMemberGroupRecipientFieldPathWarnings(['record.name'], fields)).toEqual([])
  })

  it('detects member group recipient fields from type aliases and ref metadata', () => {
    expect(isDingTalkMemberGroupRecipientField({ type: ' Member_Group ' })).toBe(true)
    expect(isDingTalkMemberGroupRecipientField({ type: 'membergroup' })).toBe(true)
    expect(isDingTalkMemberGroupRecipientField({ type: 'link', property: { refKind: ' Member-Group ' } })).toBe(true)
    expect(isDingTalkMemberGroupRecipientField({ type: 'user' })).toBe(false)
  })
})
