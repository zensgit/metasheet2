import type { PluginContext } from '@metasheet/core-backend/src/types/plugin'
import { FormulaEngine } from './formulaEngine'

export interface GridRuntimePlugin {
  activate(context: PluginContext): void
  deactivate(): void
}

const GRID_COMPONENT_REGISTRATION = {
  name: 'grid-view',
  component: 'GridView',
  category: 'views',
  title: '网格视图',
  description: '提供高级网格视图和公式计算功能',
  bundle: {
    js: 'dist/index.js.mjs',
    css: 'dist/style.css'
  }
}

export default {
  activate(context: PluginContext) {
    console.log('Grid View Plugin activated')

    // Register the runtime metadata in a Node-safe entrypoint.
    context.core.events.emit('plugin:component:register', GRID_COMPONENT_REGISTRATION)
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
} as GridRuntimePlugin

export { FormulaEngine }
