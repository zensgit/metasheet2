<template>
  <div class="property-panel">
    <div class="panel-header">
      <h3 class="panel-title">节点属性</h3>
      <button @click="$emit('close')" class="close-btn">✕</button>
    </div>

    <div class="panel-content">
      <div class="property-group">
        <label class="property-label">节点ID</label>
        <input
          type="text"
          :value="node.id"
          readonly
          class="property-input readonly"
        />
      </div>

      <div class="property-group">
        <label class="property-label">节点名称</label>
        <input
          type="text"
          v-model="properties.label"
          @input="handleUpdate"
          class="property-input"
        />
      </div>

      <div v-if="node.type === 'task'" class="property-group">
        <label class="property-label">执行人</label>
        <select v-model="properties.assignee" @change="handleUpdate" class="property-input">
          <option value="">未指定</option>
          <option value="user">指定用户</option>
          <option value="role">按角色</option>
          <option value="department">按部门</option>
          <option value="dynamic">动态分配</option>
        </select>
      </div>

      <div v-if="node.type === 'task' && properties.assignee === 'user'" class="property-group">
        <label class="property-label">用户ID</label>
        <input
          type="text"
          v-model="properties.userId"
          @input="handleUpdate"
          class="property-input"
          placeholder="输入用户ID"
        />
      </div>

      <div v-if="node.type === 'task'" class="property-group">
        <label class="property-label">超时设置</label>
        <input
          type="number"
          v-model="properties.timeout"
          @input="handleUpdate"
          class="property-input"
          placeholder="分钟"
        />
      </div>

      <div v-if="node.type === 'gateway'" class="property-group">
        <label class="property-label">网关类型</label>
        <select v-model="properties.gatewayType" @change="handleUpdate" class="property-input">
          <option value="exclusive">排他网关 (XOR)</option>
          <option value="parallel">并行网关 (AND)</option>
          <option value="inclusive">包容网关 (OR)</option>
          <option value="event">事件网关</option>
        </select>
      </div>

      <div v-if="node.type === 'gateway' && properties.gatewayType === 'exclusive'" class="property-group">
        <label class="property-label">条件表达式</label>
        <textarea
          v-model="properties.condition"
          @input="handleUpdate"
          class="property-input"
          rows="3"
          placeholder="例如: ${amount} > 1000"
        />
      </div>

      <div v-if="node.type === 'event'" class="property-group">
        <label class="property-label">事件类型</label>
        <select v-model="properties.eventType" @change="handleUpdate" class="property-input">
          <option value="timer">定时器</option>
          <option value="message">消息</option>
          <option value="signal">信号</option>
          <option value="error">错误</option>
          <option value="compensation">补偿</option>
        </select>
      </div>

      <div v-if="node.type === 'event' && properties.eventType === 'timer'" class="property-group">
        <label class="property-label">定时表达式</label>
        <input
          type="text"
          v-model="properties.timerExpression"
          @input="handleUpdate"
          class="property-input"
          placeholder="Cron表达式或ISO 8601"
        />
      </div>

      <div v-if="node.type === 'http'" class="property-group">
        <label class="property-label">HTTP方法</label>
        <select v-model="properties.httpMethod" @change="handleUpdate" class="property-input">
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
          <option value="PATCH">PATCH</option>
        </select>
      </div>

      <div v-if="node.type === 'http'" class="property-group">
        <label class="property-label">URL</label>
        <input
          type="text"
          v-model="properties.url"
          @input="handleUpdate"
          class="property-input"
          placeholder="https://api.example.com/endpoint"
        />
      </div>

      <div v-if="node.type === 'http'" class="property-group">
        <label class="property-label">请求头</label>
        <textarea
          v-model="properties.headers"
          @input="handleUpdate"
          class="property-input"
          rows="3"
          placeholder='{"Content-Type": "application/json"}'
        />
      </div>

      <div v-if="node.type === 'database'" class="property-group">
        <label class="property-label">操作类型</label>
        <select v-model="properties.dbOperation" @change="handleUpdate" class="property-input">
          <option value="select">查询</option>
          <option value="insert">插入</option>
          <option value="update">更新</option>
          <option value="delete">删除</option>
          <option value="transaction">事务</option>
        </select>
      </div>

      <div v-if="node.type === 'database'" class="property-group">
        <label class="property-label">SQL语句</label>
        <textarea
          v-model="properties.sql"
          @input="handleUpdate"
          class="property-input"
          rows="4"
          placeholder="SELECT * FROM table WHERE ..."
        />
      </div>

      <div v-if="node.type === 'script'" class="property-group">
        <label class="property-label">脚本语言</label>
        <select v-model="properties.scriptLanguage" @change="handleUpdate" class="property-input">
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="groovy">Groovy</option>
        </select>
      </div>

      <div v-if="node.type === 'script'" class="property-group">
        <label class="property-label">脚本代码</label>
        <textarea
          v-model="properties.scriptCode"
          @input="handleUpdate"
          class="property-input code"
          rows="6"
          placeholder="// 输入脚本代码"
        />
      </div>

      <div v-if="node.type === 'approval'" class="property-group">
        <label class="property-label">审批类型</label>
        <select v-model="properties.approvalType" @change="handleUpdate" class="property-input">
          <option value="single">单人审批</option>
          <option value="sequential">顺序审批</option>
          <option value="parallel">并行审批</option>
          <option value="countersign">会签</option>
        </select>
      </div>

      <div v-if="node.type === 'notification'" class="property-group">
        <label class="property-label">通知渠道</label>
        <div class="checkbox-group">
          <label class="checkbox-label">
            <input
              type="checkbox"
              v-model="properties.channels.email"
              @change="handleUpdate"
            />
            邮件
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              v-model="properties.channels.sms"
              @change="handleUpdate"
            />
            短信
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              v-model="properties.channels.dingtalk"
              @change="handleUpdate"
            />
            钉钉
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              v-model="properties.channels.feishu"
              @change="handleUpdate"
            />
            飞书
          </label>
        </div>
      </div>

      <div class="property-group">
        <label class="property-label">描述</label>
        <textarea
          v-model="properties.description"
          @input="handleUpdate"
          class="property-input"
          rows="3"
          placeholder="节点描述..."
        />
      </div>

      <div class="property-group">
        <label class="property-label">重试策略</label>
        <div class="retry-config">
          <label class="checkbox-label">
            <input
              type="checkbox"
              v-model="properties.retryEnabled"
              @change="handleUpdate"
            />
            启用重试
          </label>
          <div v-if="properties.retryEnabled" class="retry-details">
            <input
              type="number"
              v-model="properties.maxRetries"
              @input="handleUpdate"
              class="property-input small"
              placeholder="最大重试次数"
            />
            <input
              type="number"
              v-model="properties.retryDelay"
              @input="handleUpdate"
              class="property-input small"
              placeholder="重试延迟(秒)"
            />
          </div>
        </div>
      </div>

      <div class="property-group">
        <label class="property-label">错误处理</label>
        <select v-model="properties.errorHandling" @change="handleUpdate" class="property-input">
          <option value="fail">失败终止</option>
          <option value="continue">继续执行</option>
          <option value="compensate">触发补偿</option>
          <option value="fallback">降级处理</option>
        </select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import type { Node } from '@vue-flow/core'

const props = defineProps<{
  node: Node
}>()

const emit = defineEmits<{
  update: [properties: Record<string, any>]
  close: []
}>()

const properties = reactive({
  label: '',
  assignee: '',
  userId: '',
  timeout: null,
  gatewayType: 'exclusive',
  condition: '',
  eventType: 'timer',
  timerExpression: '',
  httpMethod: 'GET',
  url: '',
  headers: '',
  dbOperation: 'select',
  sql: '',
  scriptLanguage: 'javascript',
  scriptCode: '',
  approvalType: 'single',
  channels: {
    email: false,
    sms: false,
    dingtalk: false,
    feishu: false
  },
  description: '',
  retryEnabled: false,
  maxRetries: 3,
  retryDelay: 5,
  errorHandling: 'fail'
})

// Initialize properties from node data
watch(() => props.node, (node) => {
  if (node?.data) {
    Object.assign(properties, node.data)
    if (!properties.channels) {
      properties.channels = {
        email: false,
        sms: false,
        dingtalk: false,
        feishu: false
      }
    }
  }
}, { immediate: true })

const handleUpdate = () => {
  emit('update', { ...properties })
}
</script>

<style scoped>
.property-panel {
  width: 320px;
  background: white;
  border-left: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.05);
}

.panel-header {
  padding: 16px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f9fafb;
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  color: #1f2937;
}

.close-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 18px;
  color: #6b7280;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #e5e7eb;
  color: #1f2937;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.property-group {
  margin-bottom: 20px;
}

.property-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #4b5563;
  margin-bottom: 6px;
}

.property-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  color: #1f2937;
  background: white;
  transition: all 0.2s;
}

.property-input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.property-input.readonly {
  background: #f3f4f6;
  color: #6b7280;
  cursor: not-allowed;
}

.property-input.code {
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 12px;
}

.property-input.small {
  width: 48%;
  display: inline-block;
}

.property-input.small:first-child {
  margin-right: 4%;
}

textarea.property-input {
  resize: vertical;
  min-height: 60px;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: #374151;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  margin-right: 8px;
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.retry-config {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.retry-details {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

select.property-input {
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 20px;
  padding-right: 36px;
}
</style>