'use strict'

const { createHash } = require('node:crypto')
const { stableCanonicalStringify } = require('./gip-canonical-json.cjs')

// Internal pure mechanism. Callers validate the snapshot and compiled data;
// the digest itself conveys no execution authority.
// Version 2 (design baseline v2.3 §7.2, decision D18): the digest also covers the row's source binding,
// `sourceRecordDigest` (physical source record) and `creationIdentityDigest` (logical creation identity),
// each a 64-hex sha256 or null for a row drafted from pasted rowsText. So a grant's
// execution_payload_digest and the ledger's payload_digest change when either binding changes, and every
// grant approved before this version admits CONFLICT (re-approve; the one-time attempt is not consumed).
function buildYidaExecutionPayloadDigest({ snapshot, intent, data }) {
  return createHash('sha256').update(stableCanonicalStringify({
    version: 2, grantRef: snapshot.grantRef, expiresAt: snapshot.expiresAt,
    actorId: snapshot.actorId, targetRef: snapshot.targetRef,
    targetRevision: snapshot.targetRevision, planRevision: snapshot.planRevision,
    intent, data, formUuid: snapshot.config.target.formUuid,
    sourceRecordDigest: snapshot.sourceRecordDigest ?? null,
    creationIdentityDigest: snapshot.creationIdentityDigest ?? null,
  })).digest('hex')
}

module.exports = { buildYidaExecutionPayloadDigest }
