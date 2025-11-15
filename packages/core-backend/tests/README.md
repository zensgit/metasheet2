# Spreadsheet System Test Suite

This comprehensive test suite covers all aspects of the spreadsheet system including API endpoints, formula engine, database operations, and end-to-end integration scenarios.

## Test Structure

```
tests/
├── utils/              # Test utilities and helpers
│   ├── test-db.ts      # Database mocking and utilities
│   ├── test-server.ts  # Express app setup and request helpers
│   └── test-fixtures.ts # Test data fixtures and constants
├── unit/               # Unit tests
│   ├── spreadsheet-api.test.ts     # API endpoint tests
│   ├── formula-engine.test.ts      # Formula calculation tests
│   └── spreadsheet-db.test.ts      # Database operation tests
├── integration/        # Integration tests
│   └── spreadsheet-integration.test.ts  # End-to-end workflow tests
├── setup.ts           # Global test setup and custom matchers
└── README.md          # This file
```

## Test Categories

### 1. API Endpoint Tests (`spreadsheet-api.test.ts`)

Tests all REST API endpoints for spreadsheet operations:

- **Spreadsheet CRUD**: Create, read, update, delete spreadsheets
- **Sheet Management**: Add, configure, and manage sheets
- **Cell Operations**: Update cells, handle formulas, manage cell ranges
- **Error Handling**: Database unavailable, validation errors, not found errors
- **Performance**: Large dataset handling, concurrent operations

Key test scenarios:
```typescript
// Create spreadsheet with initial sheets
POST /api/spreadsheets
{
  "name": "Budget 2024",
  "initial_sheets": [{"name": "Income"}, {"name": "Expenses"}]
}

// Update multiple cells with formulas
PUT /api/spreadsheets/{id}/sheets/{sheetId}/cells
{
  "cells": [
    {"row": 0, "col": 0, "value": "100", "dataType": "number"},
    {"row": 0, "col": 1, "formula": "=A1*2", "dataType": "number"}
  ]
}
```

### 2. Formula Engine Tests (`formula-engine.test.ts`)

Comprehensive testing of the formula calculation engine:

- **Math Functions**: SUM, AVERAGE, COUNT, MAX, MIN, ABS, ROUND, etc.
- **Text Functions**: CONCATENATE, LEFT, RIGHT, MID, LEN, UPPER, LOWER
- **Logical Functions**: IF, AND, OR, NOT
- **Date Functions**: NOW, TODAY, DATE, YEAR, MONTH, DAY
- **Lookup Functions**: VLOOKUP, HLOOKUP, INDEX, MATCH
- **Statistical Functions**: STDEV, VAR, MEDIAN, MODE
- **Complex Scenarios**: Nested formulas, cell references, ranges, error handling

Key test examples:
```typescript
// Complex nested formula
const result = await engine.calculate(
  '=IF(SUM(A1:A10) > 100, "High", "Low")',
  context
)

// Range operations
const sumResult = await engine.calculate('=SUM(A1:A10)', context)

// Error handling
const errorResult = await engine.calculate('=5/0', context)
expect(errorResult).toBe('#DIV/0!')
```

### 3. Database Operations Tests (`spreadsheet-db.test.ts`)

Tests database layer operations and data integrity:

- **Spreadsheet Operations**: CRUD with proper foreign keys and constraints
- **Sheet Operations**: Creation, configuration, ordering
- **Cell Operations**: Create, update, delete with versioning
- **Formula Management**: Dependencies, calculation order, volatile functions
- **Version History**: Cell change tracking and history
- **Named Ranges**: Creation and uniqueness validation
- **Performance**: Bulk operations, large datasets, concurrent access
- **Data Integrity**: Foreign key constraints, validation, cascading deletes

### 4. Integration Tests (`spreadsheet-integration.test.ts`)

End-to-end tests combining API, formula engine, and database:

- **Complete Workflows**: Create spreadsheet → Add data → Calculate formulas
- **Real-world Scenarios**: Budget tracking, sales reports, inventory management
- **Performance Integration**: Large spreadsheets, complex formulas, concurrent users
- **Error Recovery**: Connection failures, transaction rollbacks, validation errors
- **Multi-sheet Operations**: Cross-sheet formulas, complex dependencies

Real-world test scenarios:
```typescript
// Budget spreadsheet workflow
1. Create spreadsheet with "Income" and "Expenses" sheets
2. Add budget categories and amounts
3. Create formulas: =SUM(B2:B10) for totals
4. Add conditional formatting: =IF(C2>B2, "Over Budget", "OK")
5. Verify all calculations are correct

// Sales analysis workflow
1. Import sales data across multiple sheets
2. Create summary formulas with VLOOKUP and statistical functions
3. Generate reports with complex nested formulas
4. Test performance with large datasets
```

## Test Utilities

### Database Mocking (`test-db.ts`)

- **MockDB**: Complete database interface mocking using Vitest
- **Query Builder Mocking**: Chainable query builder with realistic behavior
- **Test Data Generators**: Functions to create consistent test data
- **Performance Tracking**: Built-in performance measurement utilities
- **Custom Matchers**: Spreadsheet-specific assertion helpers

### Server Testing (`test-server.ts`)

- **Test App Creation**: Express app setup with proper middleware
- **Request Helpers**: Simplified API testing with authentication mocking
- **Response Matchers**: Custom assertions for API responses
- **Mock Authentication**: User context mocking for secure endpoints

### Test Fixtures (`test-fixtures.ts`)

- **Consistent Test Data**: Predefined spreadsheets, sheets, cells, and formulas
- **Complex Scenarios**: Multi-sheet spreadsheets with cross-references
- **Edge Cases**: Empty data, error conditions, performance test data
- **API Fixtures**: Request/response templates for consistent testing

## Custom Matchers

The test suite includes custom Jest/Vitest matchers for spreadsheet-specific assertions:

```typescript
// API response matchers
expect(response).toHaveSuccessResponse()
expect(response).toHaveErrorResponse('NOT_FOUND')

// Spreadsheet data matchers
expect('A1').toBeValidCellRef()
expect('=SUM(A1:A10)').toBeValidFormula()
expect(spreadsheet).toHaveValidSpreadsheetStructure()
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- spreadsheet-api
npm test -- formula-engine
npm test -- spreadsheet-db
npm test -- integration

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch

# Run performance tests only
npm test -- --grep "Performance"
```

## Performance Benchmarks

The test suite includes performance benchmarks to ensure the system meets requirements:

- **API Response Time**: < 200ms for typical operations
- **Formula Calculation**: < 100ms for complex formulas
- **Large Dataset Operations**: < 5s for 10,000 cells
- **Concurrent Operations**: Support 100+ simultaneous users
- **Memory Usage**: Efficient memory management for large spreadsheets

## Coverage Requirements

The test suite maintains high code coverage standards:

- **Lines**: > 80%
- **Functions**: > 85%
- **Branches**: > 75%
- **Statements**: > 80%

## Test Data Management

### Test Isolation
- Each test runs in isolation with fresh mocked data
- No shared state between tests
- Automatic cleanup of test fixtures

### Consistent Test IDs
- Predefined UUIDs for consistent test data
- Deterministic test outcomes
- Easy debugging and maintenance

### Realistic Test Data
- Real-world scenarios and edge cases
- Performance testing with appropriately sized datasets
- Complex formula dependencies and calculations

## Best Practices

### Writing Tests
1. **Use descriptive test names** that explain the scenario
2. **Follow AAA pattern**: Arrange, Act, Assert
3. **Mock external dependencies** but test integration points
4. **Include both success and error scenarios**
5. **Test edge cases** and boundary conditions

### Performance Testing
1. **Use PerformanceTracker** for consistent timing measurements
2. **Set realistic performance expectations** based on system requirements
3. **Test with appropriately sized datasets** for performance scenarios
4. **Include concurrent operation testing** for multi-user scenarios

### Error Testing
1. **Test all error conditions** including network failures, validation errors
2. **Verify error messages are helpful** and include proper error codes
3. **Test error recovery scenarios** and graceful degradation
4. **Include timeout and resource exhaustion scenarios**

## Maintenance

### Adding New Tests
1. Follow existing patterns and structure
2. Add appropriate fixtures to `test-fixtures.ts`
3. Update custom matchers if needed
4. Include performance benchmarks for new features

### Updating Tests
1. Keep tests in sync with API changes
2. Update fixtures when data models change
3. Maintain backward compatibility in test utilities
4. Update performance benchmarks as system improves

This comprehensive test suite ensures the spreadsheet system is robust, performant, and maintainable while providing confidence for continuous development and deployment.