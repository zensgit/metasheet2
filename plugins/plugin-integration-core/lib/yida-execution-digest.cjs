'use strict'

const { createHash } = require('node:crypto')
const { stableCanonicalStringify } = require('./gip-canonical-json.cjs')

// Internal pure mechanism. Callers validate the snapshot and compiled data;
// the digest itself conveys no execution authority.
function buildYidaExecutionPayloadDigest({ snapshot, intent, data }) {
  return createHash('sha256').update(stableCanonicalStringify({
    version: 1, grantRef: snapshot.grantRef, expiresAt: snapshot.expiresAt,
    actorId: snapshot.actorId, targetRef: snapshot.targetRef,
    targetRevision: snapshot.targetRevision, planRevision: snapshot.planRevision,
    intent, data, formUuid: snapshot.config.target.formUuid,
  })).digest('hex')
}

module.exports = { buildYidaExecutionPayloadDigest }
