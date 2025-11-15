# RBAC Cache Optimization Configuration

## Enhanced Preheating Strategy

### Progress Update (Round 2)
- Initial: 41.7%
- After 10 spreadsheets: 47.1% (+5.4%)
- Target: 60%

### Current Issues
- Cache hit rate: 47.1% (Target: 60%)
- Limited spreadsheet coverage (only 2 sheets)
- Limited user role diversity

### Proposed Optimizations

#### 1. Expanded Spreadsheet Coverage
```javascript
// Increase from 2 to 10 spreadsheets
const SPREADSHEET_PREHEAT_COUNT = 10;
const spreadsheets = [
  'sheet-001', 'sheet-002', 'sheet-003', 'sheet-004', 'sheet-005',
  'sheet-006', 'sheet-007', 'sheet-008', 'sheet-009', 'sheet-010'
];
```

#### 2. Enhanced User Role Matrix
```javascript
// Add more user roles for better coverage
const users = [
  'u1', 'u2', 'u3',           // Regular users
  'admin', 'viewer', 'editor', // Role-based users
  'manager', 'analyst',        // Additional roles
  'guest', 'contributor'       // Extended coverage
];
```

#### 3. Preheating Pattern
```javascript
// Matrix preheating: 10 sheets × 10 users = 100 cache entries
for (const sheet of spreadsheets) {
  for (const user of users) {
    // Preheat permission check
    await checkPermission(user, sheet, 'read');
    await checkPermission(user, sheet, 'write');
  }
}
```

#### 4. Expected Improvements
- Cache entries: 20 → 200 (10x increase)
- Expected hit rate: 41.7% → 65-75%
- Coverage: Better real-world usage simulation

## Implementation Timeline
- Phase 1: Test with 5 spreadsheets
- Phase 2: Expand to 10 spreadsheets
- Phase 3: Add intelligent preheating based on usage patterns

## Monitoring Metrics
- Cache hit rate percentage
- Response time improvement
- Memory usage impact

---
Generated: 2025-09-22T10:30:00Z