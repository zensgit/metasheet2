-- 060_add_users_hr_profile_fields.sql
-- Optional HR profile fields used by attendance onboarding and reports

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS employee_no TEXT,
      ADD COLUMN IF NOT EXISTS department TEXT,
      ADD COLUMN IF NOT EXISTS position TEXT,
      ADD COLUMN IF NOT EXISTS hire_date DATE;

    CREATE INDEX IF NOT EXISTS idx_users_employee_no
      ON users (lower(employee_no))
      WHERE employee_no IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_users_department
      ON users (lower(department))
      WHERE department IS NOT NULL;
  END IF;
END $$;
