import type { PluginContext } from '@metasheet/core-backend'
import GridView from './GridView.vue'
import { FormulaEngine } from './formulaEngine'

export interface GridViewPlugin {
  activate(context: PluginContext): void
  deactivate(): void
}

export default {
  activate(context: PluginContext) {
    console.log('Grid View Plugin activated')

    // 注册网格视图组件
    context.core.events.emit('plugin:component:register', {
      name: 'grid-view',
      component: GridView,
      category: 'views',
      title: '网格视图',
      description: '提供高级网格视图和公式计算功能'
    })

    // 注册公式引擎服务
    context.core.events.emit('plugin:service:register', {
      name: 'formula-engine',
      service: FormulaEngine,
      version: '1.0.0'
    })

    console.log('Grid View Plugin registration complete')
  },

  deactivate() {
    console.log('Grid View Plugin deactivated')
  }
} as GridViewPlugin

export { GridView, FormulaEngine }