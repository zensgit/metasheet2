# Package.json Test Scripts

Add these scripts to your `package.json` for convenient test execution:

```json
{
  "scripts": {
    "test": "vitest",
    "test:watch": "vitest --watch",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage",
    "test:api": "vitest tests/unit/spreadsheet-api.test.ts",
    "test:formula": "vitest tests/unit/formula-engine.test.ts",
    "test:db": "vitest tests/unit/spreadsheet-db.test.ts",
    "test:integration": "vitest tests/integration/spreadsheet-integration.test.ts",
    "test:unit": "vitest tests/unit/",
    "test:perf": "vitest --grep=\"Performance\"",
    "test:run": "vitest run",
    "test:run:coverage": "vitest run --coverage"
  }
}
```

## Script Usage

- `npm test` - Run all tests in watch mode
- `npm run test:run` - Run all tests once and exit
- `npm run test:coverage` - Run tests with coverage report
- `npm run test:api` - Run only API endpoint tests
- `npm run test:formula` - Run only formula engine tests
- `npm run test:db` - Run only database operation tests
- `npm run test:integration` - Run only integration tests
- `npm run test:unit` - Run all unit tests
- `npm run test:perf` - Run only performance tests
- `npm run test:ui` - Open Vitest UI for interactive testing