import { describe, expect, it } from 'vitest'
import { resolvePlmSceneCatalogAutoFocus } from '../src/components/plm/plmSceneCatalogAutoFocus'

describe('plmSceneCatalogAutoFocus', () => {
  it('keeps waiting when no transient scene focus is present', () => {
    expect(resolvePlmSceneCatalogAutoFocus('', [], [])).toEqual({
      targetSceneId: '',
      shouldClear: false,
    })
  })

  it('focuses the matching recommended scene and consumes the transient state', () => {
    expect(resolvePlmSceneCatalogAutoFocus(
      'scene-1',
      ['scene-1', 'scene-2'],
      ['scene-1', 'scene-2'],
    )).toEqual({
      targetSceneId: 'scene-1',
      shouldClear: true,
    })
  })

  it('keeps waiting until the underlying workbench scenes have loaded', () => {
    expect(resolvePlmSceneCatalogAutoFocus(
      'scene-1',
      [],
      [],
    )).toEqual({
      targetSceneId: '',
      shouldClear: false,
    })
  })

  it('clears stale transient focus when the workbench scenes are loaded but the card is unavailable', () => {
    expect(resolvePlmSceneCatalogAutoFocus(
      'scene-missing',
      ['scene-2'],
      ['scene-2', 'scene-3'],
    )).toEqual({
      targetSceneId: '',
      shouldClear: true,
    })
  })
})
