# Issue Draft: Archive Dry-Run Mode for Safe Artifact Management

**Priority**: P3 (Nice-to-Have)
**Status**: Draft
**Created**: 2025-11-12
**Related**: Phase 4 Post-Deployment Optimizations

---

## Title

`[P3] Add Dry-Run Mode to Archive Script for Preview and Validation`

---

## Labels

`observability`, `enhancement`, `p3-low`, `phase5`, `tooling`, `quality-of-life`

---

## Problem Statement

### Current Behavior

The `archive-phase3-data.sh` script immediately executes file operations without preview:

```bash
bash scripts/archive-phase3-data.sh
# → Immediately creates archive directory and copies files
# → No preview of what will be archived
# → No validation before execution
```

### Limitations

1. **No Preview**: Cannot see what will be archived before execution
2. **No Validation**: Cannot verify archive contents meet expectations
3. **No Audit Trail**: No pre-execution record for compliance scenarios
4. **Risk**: Accidental execution without review in production environments

---

## Proposed Solution

### Add `--dry-run` Flag

```bash
bash scripts/archive-phase3-data.sh --dry-run
```

**Output**:
```
=== Archive Preview (Dry-Run Mode) ===

Target Directory:
  artifacts/archive/20251112_153407/

Files to Archive:
  ✓ observability-24h.csv (2.1K)
  ✓ observability-24h-summary.json (680B)
  ✓ observe-24h.log (45K)
  ✓ checkpoint_T+2h.out (1.2K)
  ✓ checkpoint_T+12h.out (1.3K)

Will Generate:
  ✓ MANIFEST.txt (listing all archived files)

Total Archive Size: ~50.3K
Archive Path: artifacts/archive/20251112_153407/

To execute: bash scripts/archive-phase3-data.sh
```

---

## Implementation Details

### Script Modifications

```bash
#!/bin/bash
# archive-phase3-data.sh

DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Generate archive directory name
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_DIR="artifacts/archive/${TIMESTAMP}"

if [ "$DRY_RUN" = true ]; then
  echo "=== Archive Preview (Dry-Run Mode) ==="
  echo ""
  echo "Target Directory:"
  echo "  $ARCHIVE_DIR/"
  echo ""
  echo "Files to Archive:"

  total_size=0
  for file in artifacts/observability-24h.csv artifacts/observability-24h-summary.json artifacts/observe-24h.log artifacts/checkpoint_*.out; do
    if [ -f "$file" ]; then
      size=$(ls -lh "$file" | awk '{print $5}')
      echo "  ✓ $(basename "$file") ($size)"
      total_size=$((total_size + $(stat -f%z "$file" 2>/dev/null || stat -c%s "$file")))
    fi
  done

  echo ""
  echo "Will Generate:"
  echo "  ✓ MANIFEST.txt (listing all archived files)"
  echo ""
  echo "Total Archive Size: ~$(numfmt --to=iec $total_size 2>/dev/null || echo "${total_size} bytes")"
  echo "Archive Path: $ARCHIVE_DIR/"
  echo ""
  echo "To execute: bash scripts/archive-phase3-data.sh"
  exit 0
fi

# Normal execution continues...
mkdir -p "$ARCHIVE_DIR"
# ... rest of archive logic
```

---

## Benefits

1. **Safe Testing**: Test archive process in production without side effects
2. **Preview Contents**: Verify all expected files will be archived
3. **Audit Trail**: Document archive intent before execution for compliance
4. **Confidence**: Reduce risk of archiving wrong files or missing data

---

## Use Cases

### Production Archival
```bash
# Step 1: Preview
bash scripts/archive-phase3-data.sh --dry-run
# Review output, verify files and sizes

# Step 2: Execute
bash scripts/archive-phase3-data.sh
```

### CI/CD Pipeline
```bash
# Validate archive completeness before actual execution
if ! bash scripts/archive-phase3-data.sh --dry-run | grep -q "observability-24h.csv"; then
  echo "ERROR: observability-24h.csv missing from archive preview"
  exit 1
fi
```

### Compliance Documentation
```bash
# Generate archive preview for audit records
bash scripts/archive-phase3-data.sh --dry-run > audit/archive-preview-$(date +%Y%m%d).txt
```

---

## Testing Strategy

1. **Dry-Run Tests**:
   - Verify no files created when `--dry-run` used
   - Verify preview output matches actual archive contents
   - Test with missing files (should show only available files)

2. **Integration Tests**:
   - Run dry-run, then actual archive
   - Verify output consistency between preview and execution
   - Test with various file states (all present, some missing)

---

## Success Criteria

- [ ] `--dry-run` flag prevents all file operations
- [ ] Preview output accurately reflects what will be archived
- [ ] File sizes calculated correctly
- [ ] Missing files handled gracefully
- [ ] Exit codes: 0 for dry-run, 0 for success, 1 for errors

---

## Additional Enhancements (Optional)

### Validation Mode
```bash
bash scripts/archive-phase3-data.sh --validate
# Checks if all expected files exist before archiving
# Returns exit code 1 if any critical file missing
```

### Quiet Mode
```bash
bash scripts/archive-phase3-data.sh --dry-run --quiet
# Minimal output, only file list and total size
```

### JSON Output
```bash
bash scripts/archive-phase3-data.sh --dry-run --json
# Machine-readable output for automation
```

---

## Related Documents

- `scripts/archive-phase3-data.sh` - Current archive implementation
- `claudedocs/PHASE4_EXECUTION_CHECKLIST.md` - Archive execution workflow
- `claudedocs/PHASE4_POST_DEPLOYMENT_OPTIMIZATIONS.md` - Section 3: Archive Dry-Run Mode

---

## Estimated Effort

**Complexity**: Low (simple flag parsing and preview logic)
**Estimated Time**: 2-4 hours
**Dependencies**: None (can implement independently)

---

## Follow-Up Tasks

After implementation:
- [ ] Update `PHASE4_EXECUTION_CHECKLIST.md` with dry-run recommendation
- [ ] Add dry-run example to `OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md`
- [ ] Create script usage documentation with all flags
- [ ] Consider applying pattern to other scripts (`cleanup-phase1.sh`, etc.)

---

**Created by**: Claude Code (Automated)
**Context**: Phase 4 completion, safe operations enhancement
