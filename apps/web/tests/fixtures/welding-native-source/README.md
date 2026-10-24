# Fixed native test oracle

These 25 JS/JSON files are the exact dependency closure of the native workspace harness, bridge and measurement helper consumed by the qualified build21. They are test inputs, not a replacement native runtime or a fake implementation. The source loan hashes are retained in manifest.json, whose own digest is pinned by tests/utils/weldingNativeOracle.ts.

The fixture excludes C++, binaries and unrelated viewer sources. Tests must fail for missing, changed or symlinked members and a rehashed manifest; they must not fall back to a developer checkout. This input does not qualify a product release or business signoff.
