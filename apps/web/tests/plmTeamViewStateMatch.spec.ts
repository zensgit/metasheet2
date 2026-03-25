import { describe, expect, it } from 'vitest'
import { matchPlmTeamViewStateSnapshot } from '../src/views/plm/plmTeamViewStateMatch'

describe('plmTeamViewStateMatch', () => {
  it('matches structurally identical panel team-view state regardless of object key order', () => {
    expect(
      matchPlmTeamViewStateSnapshot(
        {
          role: 'primary',
          filter: 'gear',
          columns: {
            actions: false,
            mime: true,
          },
        },
        {
          filter: 'gear',
          columns: {
            mime: true,
            actions: false,
          },
          role: 'primary',
        },
      ),
    ).toBe(true)
  })

  it('detects drift after manual panel query edits', () => {
    expect(
      matchPlmTeamViewStateSnapshot(
        {
          status: 'approved',
          filter: 'eco',
          comment: 'ship-it',
        },
        {
          status: 'approved',
          filter: 'eco-2',
          comment: 'ship-it',
        },
      ),
    ).toBe(false)
  })
})
