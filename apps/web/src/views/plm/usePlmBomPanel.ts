import type { PlmBomPanelModel } from './plmPanelModels'

type UsePlmBomPanelOptions = PlmBomPanelModel

export function usePlmBomPanel(options: UsePlmBomPanelOptions) {
  const bomPanel: PlmBomPanelModel = options

  return {
    bomPanel,
  }
}
