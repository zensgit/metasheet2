# 插件权限使用指南

## 概述

MetaSheet v2 插件系统采用细粒度权限控制机制，确保插件只能访问其声明的资源。本指南帮助插件开发者理解和使用权限系统。

## 权限分类

### 1. 数据库权限 (database.*)
- `database.read` - 读取数据库
- `database.write` - 写入数据库
- `database.transaction` - 执行事务
- `database.*` - 所有数据库权限

### 2. HTTP权限 (http.*)
- `http.addRoute` - 添加HTTP路由
- `http.removeRoute` - 移除HTTP路由
- `http.request` - 发起HTTP请求
- `http.middleware` - 使用中间件

### 3. WebSocket权限 (websocket.*)
- `websocket.broadcast` - 广播消息
- `websocket.send` - 发送消息给特定用户
- `websocket.listen` - 监听WebSocket事件

### 4. 事件系统权限 (events.*)
- `events.emit` - 发送事件
- `events.listen` - 监听事件
- `events.on` - 监听事件（别名）
- `events.once` - 监听一次性事件
- `events.off` - 取消事件监听

### 5. 存储权限 (storage.*)
- `storage.read` - 读取文件
- `storage.write` - 写入文件
- `storage.delete` - 删除文件
- `storage.list` - 列出文件

### 6. 缓存权限 (cache.*)
- `cache.read` - 读取缓存
- `cache.write` - 写入缓存
- `cache.delete` - 删除缓存
- `cache.clear` - 清空缓存

### 7. 队列权限 (queue.*)
- `queue.push` - 推送任务到队列
- `queue.process` - 处理队列任务
- `queue.cancel` - 取消队列任务

### 8. 认证权限 (auth.*)
- `auth.verify` - 验证令牌（只读）
- `auth.checkPermission` - 检查权限（只读）

### 9. 通知权限 (notification.*)
- `notification.send` - 发送通知
- `notification.email` - 发送邮件通知
- `notification.webhook` - 发送Webhook通知

### 10. 指标权限 (metrics.*)
- `metrics.read` - 读取指标数据
- `metrics.write` - 写入指标数据

## 权限组

为简化配置，系统提供了预定义的权限组：

### readonly - 只读权限组
适用于：数据分析、报表、监控类插件
```json
{
  "permissions": [
    "database.read",
    "storage.read",
    "cache.read",
    "auth.verify",
    "metrics.read"
  ]
}
```

### basic - 基础权限组
适用于：简单功能插件、工具类插件
```json
{
  "permissions": [
    "database.read",
    "http.addRoute",
    "events.emit",
    "cache.read",
    "cache.write",
    "storage.read"
  ]
}
```

### standard - 标准权限组
适用于：业务功能插件、集成插件
```json
{
  "permissions": [
    "database.read",
    "database.write",
    "http.addRoute",
    "websocket.send",
    "events.emit",
    "events.listen",
    "storage.read",
    "storage.write",
    "cache.read",
    "cache.write",
    "queue.push",
    "auth.verify"
  ]
}
```

### advanced - 高级权限组
适用于：系统管理插件、高级功能插件
```json
{
  "permissions": [
    "database.*",
    "http.addRoute",
    "http.removeRoute",
    "http.request",
    "websocket.broadcast",
    "websocket.send",
    "websocket.listen",
    "events.emit",
    "events.listen",
    "events.on",
    "events.once",
    "storage.read",
    "storage.write",
    "storage.delete",
    "storage.list",
    "cache.read",
    "cache.write",
    "cache.delete",
    "cache.clear",
    "queue.push",
    "queue.process",
    "queue.cancel",
    "auth.verify",
    "auth.checkPermission",
    "notification.send",
    "notification.email",
    "metrics.read",
    "metrics.write"
  ]
}
```

## 使用示例

### 示例1：只读分析插件
```json
{
  "name": "analytics-dashboard",
  "version": "1.0.0",
  "displayName": "数据分析仪表板",
  "permissions": [
    "database.read",
    "cache.read",
    "metrics.read"
  ]
}
```

### 示例2：文件管理插件
```json
{
  "name": "file-manager",
  "version": "1.0.0",
  "displayName": "文件管理器",
  "permissions": [
    "storage.read",
    "storage.write",
    "storage.delete",
    "storage.list",
    "http.addRoute"
  ]
}
```

### 示例3：通知集成插件
```json
{
  "name": "notification-hub",
  "version": "1.0.0",
  "displayName": "通知中心",
  "permissions": [
    "notification.send",
    "notification.email",
    "notification.webhook",
    "queue.push",
    "events.listen"
  ]
}
```

### 示例4：实时协作插件
```json
{
  "name": "realtime-collab",
  "version": "1.0.0",
  "displayName": "实时协作",
  "permissions": [
    "websocket.broadcast",
    "websocket.send",
    "websocket.listen",
    "database.read",
    "database.write",
    "cache.write"
  ]
}
```

## 最佳实践

### 1. 最小权限原则
只申请插件实际需要的权限，避免过度授权。

❌ 错误示例：
```json
{
  "permissions": ["database.*", "storage.*", "websocket.*"]
}
```

✅ 正确示例：
```json
{
  "permissions": ["database.read", "storage.read"]
}
```

### 2. 使用权限组
对于常见场景，优先使用预定义的权限组。

```typescript
import { PERMISSION_GROUPS } from '@metasheet/core-backend'

const manifest = {
  name: "my-plugin",
  permissions: PERMISSION_GROUPS.standard
}
```

### 3. 权限说明文档
在插件文档中清楚说明为什么需要每个权限。

```markdown
## 权限说明
- `database.read`: 读取用户配置数据
- `http.addRoute`: 提供API端点供前端调用
- `cache.write`: 缓存计算结果以提高性能
```

### 4. 渐进式权限
开发初期使用最少权限，随功能增加逐步申请新权限。

### 5. 权限审计
定期审查插件权限，移除不再需要的权限。

## 权限检查流程

1. **Manifest验证阶段**
   - 在插件加载时检查manifest中声明的权限
   - 验证所有权限都在白名单中
   - 拒绝包含非法权限的插件

2. **运行时检查**
   - API调用时验证插件是否有相应权限
   - 记录权限违规尝试
   - 提供清晰的错误信息

## 错误处理

### 权限被拒绝错误
```typescript
{
  code: 'PLUGIN_004',
  error: 'Permission denied: system.exec',
  suggestion: 'Remove invalid permission from manifest'
}
```

### 调试权限问题
1. 检查插件manifest中的permissions数组
2. 确认所有权限都在PERMISSION_WHITELIST中
3. 查看/api/plugins接口返回的错误信息
4. 检查插件加载日志

## 未来扩展

### 计划中的权限
- `analytics.*` - 分析功能权限
- `workflow.*` - 工作流权限
- `integration.*` - 第三方集成权限
- `ai.*` - AI功能权限

### 动态权限
未来版本将支持：
- 用户授权的动态权限
- 基于角色的权限控制
- 权限继承和组合

## FAQ

### Q: 如何申请新权限？
A: 如果现有权限不满足需求，请提交Issue说明使用场景，我们会评估是否添加到白名单。

### Q: 通配符权限和具体权限的区别？
A: 通配符权限（如`database.*`）包含该类别下所有权限，具体权限只允许特定操作。

### Q: 权限可以在运行时修改吗？
A: 不可以。权限必须在manifest中静态声明，不支持运行时修改。

### Q: 如何测试权限配置？
A: 使用最小权限运行插件，逐步添加需要的权限，确保每个权限都是必要的。

## 相关资源

- [插件开发指南](../PLUGIN_DEVELOPMENT_GUIDE.md)
- [错误码参考](./src/core/plugin-errors.ts)
- [API文档](../API.md)
- [示例插件](../plugins/)

---

**最后更新**: 2025-11-03
**版本**: v2.0 - 扩展至40权限，10个功能类别
