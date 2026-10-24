# Sealed D recovery source closure

These four `.ts.txt` files are byte-for-byte copies of the existing D working-tree modules taken before the first F02 batch import source edit. The extension avoids accidental application/test TypeScript compilation; the native compatibility test explicitly reads and transpiles the exact bytes. `SHA256SUMS` pins the originals.

`commandRecovery.ts.txt` source SHA256 is `f5bceb8bff8f5d6e8786d4b05310582ff699f2584835effb877cb17a07054cdc`. Its D ES2022/CommonJS transpiled SHA256 is `301a9a3434bf7df7220ce05b3f390b585a389e8d9d284b33418383b7d4a0908a`, checked by the new native test independently of the new command recovery module. The other three files are its actual required closure, including the previous client and resource validators. Loading new code under a different name is not old-v1 proof.

The new browser test uses a separate page, opens this old module against the same native v1 `pending` store, exercises its three original protocols and verifies that the new binary record survives. The test remains unexecuted at author handoff. Runtime/browser provenance is written only by Root's authorized execution; no old evidence seals are modified.
