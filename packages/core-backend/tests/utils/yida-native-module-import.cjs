'use strict'

// Loaded through createRequire, not Vitest's transformed ESM graph. Node assigns
// the dynamic-import callback to this real CJS file, preserving CJS Error identity
// between the production ESM runner and its native protocol dependencies.
module.exports = (specifier) => import(specifier)
