This directory previously contained duplicate loader / sandbox / validator implementations.

Current authoritative implementations live in:
- core/plugin-loader.ts
- core/plugin-sandbox.ts
- core/plugin-validator.ts

Remaining files here are example / template artifacts only:
- index.js
- plugin.json
- types.ts

Do not introduce production logic in this folder. All runtime loading flows must go through the core loader facade.
