// plugin-validator.ts
// Lightweight manifest + capability validation (extensible)
import semver from 'semver';
const REQUIRED_FIELDS = ['name', 'version', 'main'];
export function validateManifest(manifest, caps) {
    const issues = [];
    for (const f of REQUIRED_FIELDS) {
        if (!(f in manifest))
            issues.push({ level: 'error', message: `Missing required field: ${f}` });
    }
    if (manifest.version && !semver.valid(manifest.version)) {
        issues.push({ level: 'error', message: `Invalid version: ${manifest.version}` });
    }
    if (caps && manifest.capabilities) {
        for (const c of manifest.capabilities) {
            if (!caps.has(c))
                issues.push({ level: 'warning', message: `Capability not in matrix: ${c}` });
        }
    }
    return { ok: issues.filter(i => i.level === 'error').length === 0, issues };
}
//# sourceMappingURL=plugin-validator.js.map