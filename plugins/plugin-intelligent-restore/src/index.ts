import type { PluginContext } from '@metasheet/core-backend'
import IntelligentRestoreView from './IntelligentRestoreView.vue'
import { IntelligentStorageService } from './IntelligentStorageService'
import { CompressionService } from './CompressionService'
import { OperationClassifier } from './OperationClassifier'

export interface IntelligentRestorePlugin {
  activate(context: PluginContext): void
  deactivate(): void
}

export default {
  activate(context: PluginContext) {
    console.log('Intelligent Restore Plugin activated')

    // 注册智能恢复视图组件
    context.core.events.emit('plugin:component:register', {
      name: 'intelligent-restore-view',
      component: IntelligentRestoreView,
      category: 'tools',
      title: '智能恢复系统',
      description: '智能版本控制和恢复系统，支持智能存储、压缩、列级恢复等高级功能'
    })

    // 注册智能存储服务
    context.core.events.emit('plugin:service:register', {
      name: 'intelligent-storage',
      service: IntelligentStorageService,
      version: '1.0.0'
    })

    // 注册压缩服务
    context.core.events.emit('plugin:service:register', {
      name: 'compression-service',
      service: CompressionService,
      version: '1.0.0'
    })

    // 注册操作分类器
    context.core.events.emit('plugin:service:register', {
      name: 'operation-classifier',
      service: OperationClassifier,
      version: '1.0.0'
    })

    // 注册命令
    context.core.events.emit('plugin:command:register', {
      id: 'restore.smart',
      title: '智能恢复',
      handler: (args: any) => {
        console.log('智能恢复命令执行', args)
      }
    })

    context.core.events.emit('plugin:command:register', {
      id: 'restore.column',
      title: '列恢复',
      handler: (args: any) => {
        console.log('列恢复命令执行', args)
      }
    })

    context.core.events.emit('plugin:command:register', {
      id: 'restore.snapshot',
      title: '快照恢复',
      handler: (args: any) => {
        console.log('快照恢复命令执行', args)
      }
    })

    console.log('Intelligent Restore Plugin registration complete')
  },

  deactivate() {
    console.log('Intelligent Restore Plugin deactivated')
  }
} as IntelligentRestorePlugin

export { IntelligentRestoreView, IntelligentStorageService, CompressionService, OperationClassifier }