-- RBAC 初始化脚本
-- 用于生产环境首次部署 PR #246

-- ============================================
-- 1. 创建基础角色
-- ============================================
INSERT INTO rbac_roles (name, description, created_at, updated_at)
VALUES
  ('admin', 'Full access to all resources', NOW(), NOW()),
  ('editor', 'Can create, edit and view resources', NOW(), NOW()),
  ('viewer', 'Read-only access to resources', NOW(), NOW()),
  ('guest', 'Limited guest access', NOW(), NOW())
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description, updated_at = NOW();

-- ============================================
-- 2. 创建基础权限
-- ============================================

-- 表级权限
INSERT INTO rbac_permissions (name, resource, action, description, created_at, updated_at)
VALUES
  -- 所有表的读写权限
  ('tables.*.read', 'tables', 'read', 'Read access to all tables', NOW(), NOW()),
  ('tables.*.write', 'tables', 'write', 'Write access to all tables', NOW(), NOW()),
  ('tables.*.delete', 'tables', 'delete', 'Delete access to all tables', NOW(), NOW()),

  -- 视图权限
  ('views.*.read', 'views', 'read', 'Read access to all views', NOW(), NOW()),
  ('views.*.write', 'views', 'write', 'Write access to all views', NOW(), NOW()),
  ('views.*.delete', 'views', 'delete', 'Delete access to all views', NOW(), NOW()),

  -- 用户管理权限
  ('users.*.read', 'users', 'read', 'Read access to user information', NOW(), NOW()),
  ('users.*.write', 'users', 'write', 'Write access to user information', NOW(), NOW()),

  -- 权限管理权限
  ('rbac.roles.read', 'rbac', 'read', 'Read access to RBAC roles', NOW(), NOW()),
  ('rbac.roles.write', 'rbac', 'write', 'Manage RBAC roles', NOW(), NOW()),
  ('rbac.permissions.read', 'rbac', 'read', 'Read access to RBAC permissions', NOW(), NOW()),
  ('rbac.permissions.write', 'rbac', 'write', 'Manage RBAC permissions', NOW(), NOW())
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description, updated_at = NOW();

-- ============================================
-- 3. 角色-权限映射
-- ============================================

-- Admin: 全部权限
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
CROSS JOIN rbac_permissions p
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Editor: 读写权限（不含删除和 RBAC 管理）
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
CROSS JOIN rbac_permissions p
WHERE r.name = 'editor'
  AND p.action IN ('read', 'write')
  AND p.resource NOT IN ('rbac')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Viewer: 仅读权限
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
CROSS JOIN rbac_permissions p
WHERE r.name = 'viewer'
  AND p.action = 'read'
  AND p.resource NOT IN ('rbac')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Guest: 最小读权限（仅视图）
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
CROSS JOIN rbac_permissions p
WHERE r.name = 'guest'
  AND p.name = 'views.*.read'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================
-- 4. 用户角色分配（示例）
-- ============================================

-- 注意：需要根据实际情况修改用户邮箱和角色分配

-- 示例：分配管理员角色给系统管理员
-- INSERT INTO rbac_user_roles (user_id, role_id, created_at)
-- SELECT
--   u.id,
--   (SELECT id FROM rbac_roles WHERE name = 'admin'),
--   NOW()
-- FROM users u
-- WHERE u.email IN ('admin@example.com', 'superuser@example.com')
-- ON CONFLICT (user_id, role_id) DO NOTHING;

-- 示例：分配编辑者角色给工程团队
-- INSERT INTO rbac_user_roles (user_id, role_id, created_at)
-- SELECT
--   u.id,
--   (SELECT id FROM rbac_roles WHERE name = 'editor'),
--   NOW()
-- FROM users u
-- WHERE u.department = 'engineering'
-- ON CONFLICT (user_id, role_id) DO NOTHING;

-- 示例：分配查看者角色给所有其他用户
-- INSERT INTO rbac_user_roles (user_id, role_id, created_at)
-- SELECT DISTINCT
--   u.id,
--   (SELECT id FROM rbac_roles WHERE name = 'viewer'),
--   NOW()
-- FROM users u
-- WHERE u.id NOT IN (
--   SELECT user_id FROM rbac_user_roles
-- )
-- ON CONFLICT (user_id, role_id) DO NOTHING;

-- ============================================
-- 5. 验证配置
-- ============================================

-- 统计角色数量
SELECT COUNT(*) as role_count FROM rbac_roles;

-- 统计权限数量
SELECT COUNT(*) as permission_count FROM rbac_permissions;

-- 统计角色-权限映射
SELECT
  r.name as role,
  COUNT(rp.permission_id) as permission_count
FROM rbac_roles r
LEFT JOIN rbac_role_permissions rp ON r.id = rp.role_id
GROUP BY r.name
ORDER BY r.name;

-- 统计用户-角色分配
SELECT
  r.name as role,
  COUNT(ur.user_id) as user_count
FROM rbac_roles r
LEFT JOIN rbac_user_roles ur ON r.id = ur.role_id
GROUP BY r.name
ORDER BY r.name;

-- 显示完整的权限矩阵
SELECT
  r.name as role,
  STRING_AGG(p.name, ', ' ORDER BY p.name) as permissions
FROM rbac_roles r
LEFT JOIN rbac_role_permissions rp ON r.id = rp.role_id
LEFT JOIN rbac_permissions p ON rp.permission_id = p.id
GROUP BY r.name
ORDER BY r.name;
