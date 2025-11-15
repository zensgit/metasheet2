"use strict";
// plugin-validator.ts
// Lightweight manifest + capability validation (extensible)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateManifest = validateManifest;
const semver_1 = __importDefault(require("semver"));
const REQUIRED_FIELDS = ['name', 'version', 'main'];
function validateManifest(manifest, caps) {
    const issues = [];
    for (const f of REQUIRED_FIELDS) {
        if (!(f in manifest))
            issues.push({ level: 'error', message: `Missing required field: ${f}` });
    }
    if (manifest.version && !semver_1.default.valid(manifest.version)) {
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