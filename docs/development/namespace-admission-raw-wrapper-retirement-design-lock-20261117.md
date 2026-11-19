# Namespace admission raw wrapper retirement

Retire the exported `setUserNamespaceAdmission` raw transaction wrapper. Fresh first-party source/import search found no production caller and one real integration-test consumer. Independent design review accepted this bounded removal. No replacement raw execution surface or actor-optional command is added.

Preserve the integration test's pending-bootstrap/zero-insert/final-disabled-state oracle, invoking the existing platform admission command with a separately seeded live raw-admin actor. Only imports made orphaned by the removal and the stale ownership comment change beside the removed function. Existing W16 SQL and all other namespace helpers remain unchanged. W16 stays pending for both birth producers and the remaining formal gates.

Verify the adapted entire isolated PG suite and adjacent platform admission unit suite. A focused regression rejects restoration of the exported raw wrapper. Keep source mutations byte-snapshotted and exactly restored; local evidence does not establish remote CI or full B2 acceptance. No install, commit, push, deployment, real data or enabled purpose/flag.
