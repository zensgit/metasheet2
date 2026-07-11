-- 067_add_restored_from_version_to_record_revisions.sql
-- R11 restore back-reference (OD-0=(a)). Records which source record-version a `source='restore'`
-- record-version restore wrote from, so History Center can render "restored from version N". Nullable,
-- forward-only, NO backfill (legacy rows stay NULL — not inferred). Only the three record-version restore
-- routes (record-restore-execute, restore-batch-execute, legacy /restore) populate it; every other write —
-- including non-version-restore `source='restore'` emitters (PIT-resurrect, PIT-reset, lossy-retype-revert)
-- — leaves it NULL by design. The FE badge keys on NON-NULL, never on source='restore'.

DO $$
BEGIN
  IF to_regclass('public.meta_record_revisions') IS NOT NULL THEN
    ALTER TABLE meta_record_revisions
      ADD COLUMN IF NOT EXISTS restored_from_version INT;
  END IF;
END $$;
