# Gallery 和 Form 视图开发文档

## 概述
成功实现了 MetaSheet 多视图系统的 Gallery（画廊）和 Form（表单）视图，这是架构升级计划中的 P0 优先级功能。这两个视图扩展了现有的 Grid、Kanban、Calendar 视图系统，提供了卡片式数据展示和表单式数据输入能力。

## 分支信息
- **分支名称**: `feat/gallery-form-views`
- **基础分支**: `main`
- **状态**: 已推送，可创建 PR

## 实现详情

### 1. 类型定义 (`apps/web/src/types/views.ts`)

#### ViewType 扩展
```typescript
export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'form'
```

#### Gallery 配置类型
```typescript
interface GalleryConfig {
  cardTemplate: {
    titleField?: string
    contentFields: string[]
    imageField?: string
    tagField?: string
  }
  layout: {
    columns: 'auto' | number
    cardSize: 'small' | 'medium' | 'large'
    spacing: number
  }
  display: {
    showImage: boolean
    showTags: boolean
    truncateContent: number
  }
}
```

#### Form 配置类型
```typescript
interface FormConfig {
  fields: FormField[]
  settings: {
    title: string
    description?: string
    requireAuth: boolean
    allowPublicAccess: boolean
    allowMultipleSubmissions: boolean
    theme: 'default' | 'minimal' | 'colorful'
  }
}

interface FormField {
  id: string
  type: FieldType
  label: string
  required: boolean
  validation?: ValidationRule
  conditional?: ConditionalLogic
  options?: string[] // for select/multiselect
}
```

### 2. ViewManager 服务 (`apps/web/src/services/ViewManager.ts`)

#### 核心功能
- **配置管理**: 加载和保存视图配置
- **数据获取**: 支持分页、过滤、排序的数据加载
- **状态管理**: 用户视图状态持久化
- **表单提交**: 处理表单数据提交
- **缓存机制**: ETag 缓存优化性能

#### 主要方法
```typescript
class ViewManager {
  // 通用方法
  async loadViewConfig(viewId: string): Promise<ViewConfig>
  async saveViewConfig(viewId: string, config: ViewConfig)
  async loadData(viewId: string, options?: DataLoadOptions)

  // Gallery 专用
  async createGalleryView(spreadsheetId: string, config: GalleryConfig)

  // Form 专用
  async createFormView(spreadsheetId: string, config: FormConfig)
  async submitForm(viewId: string, data: FormData)
  async getFormResponses(viewId: string, options?: QueryOptions)
}
```

### 3. Gallery 视图 (`apps/web/src/views/GalleryView.vue`)

#### 主要特性
- **响应式布局**: CSS Grid 自适应列数（2-6列）
- **卡片模板**: 可配置标题、内容、图片、标签字段
- **图片支持**: 图片预览和点击放大功能
- **搜索过滤**: 实时搜索和标签筛选
- **详情模态**: 点击卡片查看完整记录
- **懒加载**: 虚拟滚动优化大数据集性能
- **配置界面**: 可视化配置卡片模板和布局

#### 布局配置
```typescript
const layoutOptions = {
  columns: {
    auto: '自适应',
    2: '2列',
    3: '3列',
    4: '4列',
    6: '6列'
  },
  cardSize: {
    small: '小卡片 (200px)',
    medium: '中卡片 (250px)',
    large: '大卡片 (300px)'
  }
}
```

#### CSS Grid 响应式
```css
.gallery-grid {
  display: grid;
  gap: var(--gallery-spacing);
  grid-template-columns: repeat(var(--gallery-columns), 1fr);
}

@media (max-width: 768px) {
  .gallery-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
```

### 4. Form 视图 (`apps/web/src/views/FormView.vue`)

#### 支持的字段类型（15种）
1. **文本类**: text, textarea, email, url, phone
2. **数字类**: number, slider, rating
3. **选择类**: select, multiselect, radio, checkbox
4. **日期类**: date, datetime, time
5. **媒体类**: file, image
6. **其他**: color

#### 表单验证
```typescript
const validationRules = {
  required: (value: any) => !!value || '此字段为必填项',
  email: (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || '请输入有效邮箱',
  minLength: (min: number) => (value: string) =>
    value.length >= min || `最少需要${min}个字符`,
  pattern: (regex: RegExp) => (value: string) =>
    regex.test(value) || '格式不正确'
}
```

#### 条件显示逻辑
```typescript
interface ConditionalLogic {
  field: string
  operator: 'equals' | 'not_equals' | 'contains' | 'gt' | 'lt'
  value: any
  action: 'show' | 'hide' | 'require'
}
```

#### 公开表单分享
- 生成唯一的公开访问链接
- 支持无需登录的表单提交
- IP 地址和用户代理记录
- 提交限制配置

### 5. 后端 API (`packages/core-backend/src/routes/views.ts`)

#### API 端点
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/views/:viewId/config` | 获取视图配置 |
| PUT | `/api/views/:viewId/config` | 更新视图配置 |
| GET | `/api/views/:viewId/data` | 获取视图数据 |
| POST | `/api/views/:viewId/submit` | 提交表单数据 |
| GET | `/api/views/:viewId/responses` | 获取表单响应 |
| GET/POST | `/api/views/:viewId/state` | 获取/保存用户状态 |
| POST | `/api/views` | 创建新视图 |
| DELETE | `/api/views/:viewId` | 删除视图 |

#### 安全特性
- JWT 身份验证
- 用户权限检查
- 表单提交频率限制
- 敏感数据脱敏
- SQL 注入防护

#### 数据查询优化
```typescript
// 支持复杂查询参数
interface DataLoadOptions {
  page?: number
  limit?: number
  search?: string
  filters?: Record<string, any>
  sort?: { field: string; order: 'asc' | 'desc' }[]
}
```

### 6. 数据库架构 (`packages/core-backend/migrations/037_add_gallery_form_support.sql`)

#### 新增表结构

##### view_configs 表
```sql
CREATE TABLE view_configs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    spreadsheet_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('grid', 'kanban', 'calendar', 'gallery', 'form')),
    name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

##### view_states 表
```sql
CREATE TABLE view_states (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    user_id TEXT NOT NULL,
    view_id TEXT NOT NULL REFERENCES view_configs(id) ON DELETE CASCADE,
    state JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, view_id)
);
```

##### form_responses 表
```sql
CREATE TABLE form_responses (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    view_id TEXT NOT NULL REFERENCES view_configs(id) ON DELETE CASCADE,
    data JSONB NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT,
    user_id TEXT,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'processed', 'archived'))
);
```

#### 性能优化索引
```sql
-- 视图配置查询优化
CREATE INDEX idx_view_configs_spreadsheet_type ON view_configs(spreadsheet_id, type);

-- 用户状态查询优化
CREATE INDEX idx_view_states_user_view ON view_states(user_id, view_id);

-- 表单响应查询优化
CREATE INDEX idx_form_responses_view_submitted ON form_responses(view_id, submitted_at DESC);
CREATE INDEX idx_form_responses_user ON form_responses(user_id) WHERE user_id IS NOT NULL;
```

#### 示例数据
预设了 Gallery 和 Form 的示例配置，便于开发和测试。

### 7. 系统集成

#### 视图注册 (`apps/web/src/view-registry.ts`)
```typescript
export const viewRegistry = {
  grid: () => import('@/views/GridView.vue'),
  kanban: () => import('@/views/KanbanView.vue'),
  calendar: () => import('@/views/CalendarView.vue'),
  gallery: () => import('@/views/GalleryView.vue'),    // 新增
  form: () => import('@/views/FormView.vue')           // 新增
}
```

#### 后端路由注册 (`packages/core-backend/src/index.ts`)
```typescript
// 注册视图管理路由
app.use(viewsRouter)
```

#### 认证集成
- 复用现有的 JWT 认证机制
- 支持公开表单的匿名访问
- 用户权限验证

## 技术特点

### 性能优化
- **ETag 缓存**: 减少不必要的数据传输
- **懒加载**: 虚拟滚动处理大数据集
- **防抖保存**: 避免频繁的状态更新
- **分页加载**: 按需加载数据
- **图片优化**: 支持图片懒加载和压缩

### 响应式设计
- **移动优先**: 移动端优化的界面设计
- **断点适配**: 不同屏幕尺寸的布局调整
- **触摸友好**: 移动设备的交互优化

### 用户体验
- **直观配置**: 可视化的配置界面
- **实时预览**: 配置更改的实时反馈
- **错误处理**: 友好的错误提示和恢复机制
- **加载状态**: 清晰的加载和处理状态指示

### 安全性
- **数据验证**: 前后端双重数据验证
- **XSS 防护**: 用户输入的安全处理
- **CSRF 保护**: 跨站请求伪造防护
- **权限控制**: 细粒度的访问权限管理

## 使用示例

### 创建 Gallery 视图
```javascript
const galleryConfig = {
  cardTemplate: {
    titleField: 'title',
    contentFields: ['description', 'category'],
    imageField: 'thumbnail',
    tagField: 'tags'
  },
  layout: {
    columns: 'auto',
    cardSize: 'medium',
    spacing: 16
  },
  display: {
    showImage: true,
    showTags: true,
    truncateContent: 100
  }
}

await viewManager.createGalleryView(spreadsheetId, galleryConfig)
```

### 创建 Form 视图
```javascript
const formConfig = {
  fields: [
    {
      id: 'name',
      type: 'text',
      label: '姓名',
      required: true,
      validation: { minLength: 2 }
    },
    {
      id: 'email',
      type: 'email',
      label: '邮箱',
      required: true
    },
    {
      id: 'category',
      type: 'select',
      label: '类别',
      options: ['技术', '产品', '设计', '市场']
    }
  ],
  settings: {
    title: '用户反馈表单',
    description: '请填写您的反馈意见',
    requireAuth: false,
    allowPublicAccess: true,
    allowMultipleSubmissions: true,
    theme: 'default'
  }
}

await viewManager.createFormView(spreadsheetId, formConfig)
```

### 提交表单数据
```javascript
const formData = {
  name: 'John Doe',
  email: 'john@example.com',
  category: '技术',
  feedback: '产品很不错，建议增加更多功能'
}

await viewManager.submitForm(viewId, formData)
```

## 文件清单

### 新建文件
1. `apps/web/src/types/views.ts` - 类型定义
2. `apps/web/src/services/ViewManager.ts` - 视图管理服务
3. `apps/web/src/views/GalleryView.vue` - Gallery 视图组件
4. `apps/web/src/views/FormView.vue` - Form 视图组件
5. `packages/core-backend/src/routes/views.ts` - 后端 API 路由
6. `packages/core-backend/migrations/037_add_gallery_form_support.sql` - 数据库迁移

### 修改文件
1. `apps/web/src/view-registry.ts` - 注册新视图组件
2. `packages/core-backend/src/index.ts` - 注册 API 路由

## 部署说明

### 环境要求
- Node.js 18+
- PostgreSQL 13+
- Vue 3 + TypeScript
- Element Plus UI 库

### 部署步骤
1. **运行数据库迁移**:
   ```bash
   npm run migrate
   ```

2. **安装前端依赖**:
   ```bash
   cd apps/web && npm install
   ```

3. **构建前端**:
   ```bash
   npm run build
   ```

4. **启动服务**:
   ```bash
   npm run start
   ```

### 配置选项
```env
# 表单上传文件大小限制 (MB)
FORM_UPLOAD_LIMIT=10

# 表单响应保留天数
FORM_RESPONSE_RETENTION=365

# Gallery 图片缓存时间 (秒)
GALLERY_IMAGE_CACHE_TTL=3600
```

## 测试说明

### 功能测试
- Gallery 视图的卡片布局和响应式
- Form 视图的字段类型和验证
- 视图切换和状态保存
- 公开表单的访问和提交
- 数据加载和性能

### 测试用例
1. **Gallery 视图测试**:
   - 不同布局配置的渲染
   - 图片加载和预览功能
   - 搜索和过滤功能
   - 响应式布局适配

2. **Form 视图测试**:
   - 各种字段类型的输入和验证
   - 条件显示逻辑
   - 表单提交和响应
   - 公开访问功能

3. **集成测试**:
   - 视图间的切换
   - 数据同步和更新
   - 用户权限和安全性
   - 性能和并发处理

## 后续改进

### 短期优化
1. **性能优化**: 图片懒加载和压缩
2. **用户体验**: 拖拽排序和批量操作
3. **移动端**: 触摸手势和移动适配
4. **国际化**: 多语言支持

### 长期规划
1. **高级表单**: 文件上传、富文本编辑器
2. **数据可视化**: 图表和统计面板
3. **工作流集成**: 表单触发工作流
4. **第三方集成**: 与外部服务的对接

## 结论
成功实现了 Gallery 和 Form 视图，完成了多视图系统的重要扩展。这两个视图为 MetaSheet 平台提供了更丰富的数据展示和交互方式，提升了用户体验和功能完整性。实现遵循了现有的架构模式，保证了系统的一致性和可维护性。