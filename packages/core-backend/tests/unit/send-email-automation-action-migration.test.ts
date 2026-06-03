import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL,
  AUTOMATION_ACTION_TYPES_WITH_SEND_EMAIL,
} from '../../src/db/migrations/zzzz20260508120000_add_send_email_automation_action'

describe('send_email automation action migration', () => {
  // The app-level ⇄ DB-constraint SYNC check now lives with the LATEST constraint migration
  // (wait-for-callback-automation-action-migration.test.ts). This file locks the send_email delta.
  it('adds send_email on top of the prior action set (and nothing else)', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_SEND_EMAIL).toContain('send_email')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL).not.toContain('send_email')
    expect(AUTOMATION_ACTION_TYPES_WITH_SEND_EMAIL.filter((a) => a !== 'send_email'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL])
  })

  it('preserves legacy action types that are still accepted by automation_rules', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_SEND_EMAIL).toEqual([
      'notify',
      'update_field',
      'update_record',
      'create_record',
      'send_webhook',
      'send_notification',
      'send_email',
      'send_dingtalk_group_message',
      'send_dingtalk_person_message',
      'lock_record',
    ])
  })

  it('rolls back only the send_email widening', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL).not.toContain('send_email')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL).toContain('send_dingtalk_group_message')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL).toContain('send_dingtalk_person_message')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_SEND_EMAIL).toContain('lock_record')
  })
})
