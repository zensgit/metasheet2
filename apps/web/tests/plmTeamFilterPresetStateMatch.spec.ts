import { describe, expect, it } from 'vitest'
import {
  matchPlmTeamFilterPresetStateSnapshot,
  pickPlmTeamFilterPresetStateKeys,
} from '../src/views/plm/plmTeamFilterPresetStateMatch'

describe('plmTeamFilterPresetStateMatch', () => {
  it('matches structurally identical team preset state regardless of object key order', () => {
    expect(
      matchPlmTeamFilterPresetStateSnapshot(
        {
          field: 'path',
          value: 'root/a',
          group: '机械',
        },
        {
          group: '机械',
          value: 'root/a',
          field: 'path',
        },
      ),
    ).toBe(true)
  })

  it('detects drift after manual filter edits', () => {
    expect(
      matchPlmTeamFilterPresetStateSnapshot(
        {
          field: 'path',
          value: 'root/a',
          group: '机械',
        },
        {
          field: 'path',
          value: 'root/b',
          group: '机械',
        },
      ),
    ).toBe(false)
  })

  it('picks only the compared preset state keys before matching route owners', () => {
    expect(
      pickPlmTeamFilterPresetStateKeys(
        {
          field: 'path',
          value: 'root/a',
          group: '机械',
          ignoredFutureKey: 'should-not-keep-route-owner',
        },
        ['field', 'value', 'group'],
      ),
    ).toEqual({
      field: 'path',
      value: 'root/a',
      group: '机械',
    })
  })
})
