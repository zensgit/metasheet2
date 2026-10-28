'use strict'

// R67 ③ — the dry-run response's `plmReadPhase.wallMs` is a CLOCK READING (how long the PLM read
// phase took), so it is the one value in a dry-run response — besides the freshly minted
// `dryRunToken`, which these suites already set aside — that two dry-runs of an unchanged project do
// not share. A test that asserts two responses are the same drops it, and ONLY it: the rest of the
// stanza (configured read width, peak reads in flight, queries issued / not consumed) is
// deterministic for a deterministic source and stays compared.
//
// Returns a JSON copy (the shape that goes over the wire), so the caller's object is untouched.
function withoutReadPhaseClock(payload) {
  const copy = JSON.parse(JSON.stringify(payload))
  if (copy && typeof copy === 'object' && copy.plmReadPhase && typeof copy.plmReadPhase === 'object') {
    delete copy.plmReadPhase.wallMs
  }
  return copy
}

module.exports = { withoutReadPhaseClock }
