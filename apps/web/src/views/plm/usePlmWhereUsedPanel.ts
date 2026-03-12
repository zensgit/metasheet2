import type { PlmWhereUsedPanelModel } from './plmPanelModels'

type UsePlmWhereUsedPanelOptions = PlmWhereUsedPanelModel

export function usePlmWhereUsedPanel(options: UsePlmWhereUsedPanelOptions) {
  const whereUsedPanel: PlmWhereUsedPanelModel = options

  return {
    whereUsedPanel,
  }
}
