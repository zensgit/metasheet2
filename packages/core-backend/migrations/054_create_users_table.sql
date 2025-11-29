-- 054_create_users_table.sql
-- 用户表，支持JWT认证

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 只有当触发器不存在时才创建
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trigger_update_users_updated_at'
  ) THEN
    CREATE TRIGGER trigger_update_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION update_users_updated_at();
  END IF;
END $$;

-- 插入基础角色到roles表（如果不存在）
INSERT INTO roles (id, name) VALUES
  ('admin', '管理员'),
  ('user', '普通用户')
ON CONFLICT (id) DO NOTHING;

-- 插入基础权限到permissions表（如果不存在）
INSERT INTO permissions (code, description) VALUES
  ('*:*', '所有权限'),
  ('spreadsheet:read', '读取电子表格'),
  ('spreadsheet:write', '编辑电子表格'),
  ('spreadsheet:delete', '删除电子表格'),
  ('spreadsheet:share', '分享电子表格'),
  ('admin:users', '管理用户'),
  ('admin:roles', '管理角色'),
  ('admin:permissions', '管理权限')
ON CONFLICT (code) DO NOTHING;

-- 为admin角色分配所有权限（如果不存在）
INSERT INTO role_permissions (role_id, permission_code) VALUES
  ('admin', '*:*')
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- 为user角色分配基础权限（如果不存在）
INSERT INTO role_permissions (role_id, permission_code) VALUES
  ('user', 'spreadsheet:read'),
  ('user', 'spreadsheet:write')
ON CONFLICT (role_id, permission_code) DO NOTHING;