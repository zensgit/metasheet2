import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>) {
  // Create permissions table (base table for permission codes)
  await db.schema
    .createTable('permissions')
    .ifNotExists()
    .addColumn('code', 'varchar(255)', col => col.primaryKey())
    .addColumn('name', 'varchar(255)', col => col.notNull())
    .addColumn('description', 'text')
    .addColumn('created_at', 'timestamp', col => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .execute()

  // Ensure all columns exist (for tables that existed before this migration)
  await sql`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS name varchar(255)`.execute(db)
  await sql`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS description text`.execute(db)
  await sql`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL`.execute(db)

  // Insert basic permissions for testing/demo
  await sql`
    INSERT INTO permissions (code, name, description)
    VALUES
      ('demo:read', 'Demo Read', 'Read access for demo purposes'),
      ('demo:write', 'Demo Write', 'Write access for demo purposes'),
      ('test:read', 'Test Read', 'Read access for testing'),
      ('test:write', 'Test Write', 'Write access for testing'),
      ('admin:all', 'Admin All', 'Full admin access')
    ON CONFLICT (code) DO NOTHING
  `.execute(db)

  // Create user_roles table
  await db.schema
    .createTable('user_roles')
    .ifNotExists()
    .addColumn('user_id', 'varchar(255)', col => col.notNull())
    .addColumn('role_id', 'varchar(255)', col => col.notNull())
    .addColumn('created_at', 'timestamp', col => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .execute()

  // Add composite primary key for user_roles (conditional to avoid conflict)
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_pkey' AND conrelid = 'user_roles'::regclass
      ) THEN
        ALTER TABLE user_roles ADD PRIMARY KEY (user_id, role_id);
      END IF;
    END $$;
  `.execute(db)

  // Create user_permissions table
  await db.schema
    .createTable('user_permissions')
    .ifNotExists()
    .addColumn('user_id', 'varchar(255)', col => col.notNull())
    .addColumn('permission_code', 'varchar(255)', col => col.notNull())
    .addColumn('created_at', 'timestamp', col => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .execute()

  // Add composite primary key for user_permissions (conditional to avoid conflict)
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_permissions_pkey' AND conrelid = 'user_permissions'::regclass
      ) THEN
        ALTER TABLE user_permissions ADD PRIMARY KEY (user_id, permission_code);
      END IF;
    END $$;
  `.execute(db)

  // Create role_permissions table
  await db.schema
    .createTable('role_permissions')
    .ifNotExists()
    .addColumn('role_id', 'varchar(255)', col => col.notNull())
    .addColumn('permission_code', 'varchar(255)', col => col.notNull())
    .addColumn('created_at', 'timestamp', col => col.defaultTo(sql`CURRENT_TIMESTAMP`).notNull())
    .execute()

  // Add composite primary key for role_permissions (conditional to avoid conflict)
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_pkey' AND conrelid = 'role_permissions'::regclass
      ) THEN
        ALTER TABLE role_permissions ADD PRIMARY KEY (role_id, permission_code);
      END IF;
    END $$;
  `.execute(db)

  // Add foreign key constraints to reference permissions table (conditional)
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_permissions_permission_code_fkey'
      ) THEN
        ALTER TABLE user_permissions
        ADD CONSTRAINT user_permissions_permission_code_fkey
        FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'role_permissions_permission_code_fkey'
      ) THEN
        ALTER TABLE role_permissions
        ADD CONSTRAINT role_permissions_permission_code_fkey
        FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE;
      END IF;
    END $$;
  `.execute(db)

  // Create indexes for better query performance (with IF NOT EXISTS)
  await sql`CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON role_permissions(role_id)`.execute(db)
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('role_permissions').execute()
  await db.schema.dropTable('user_permissions').execute()
  await db.schema.dropTable('user_roles').execute()
  await db.schema.dropTable('permissions').execute()
}
