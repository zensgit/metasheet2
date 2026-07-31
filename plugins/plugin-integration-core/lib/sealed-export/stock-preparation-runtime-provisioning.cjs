'use strict'

const crypto = require('node:crypto')

const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  createSealedExportLifecycleProvisioning,
} = require('./sealed-export-lifecycle-provisioning.cjs')
const {
  isStockPreparationProvisioningDatabase,
} = require('./stock-preparation-runtime-database.cjs')
const {
  createSqlServerSealedSnapshotService,
} = require('./sqlserver-sealed-snapshot-service.cjs')
const {
  deriveStockPreparationSqlServerSourceAnchors,
  CANONICAL_OBJECT_VERSION,
} = require('./stock-preparation-sqlserver-source-authority.cjs')
const {
  OBJECT_KEY,
  RELATION_ID,
} = require('./stock-preparation-runtime-store.cjs')

function createStockPreparationRuntimeProvisioning({
  artifactRoot,
  identityKey,
  privateSignerMaterial,
  provisioningDatabase,
  qualificationKeyring,
} = {}) {
  if (
    typeof artifactRoot !== 'string'
    || artifactRoot.length < 1
    || !(identityKey instanceof Uint8Array)
    || identityKey.byteLength < 32
    || !privateSignerMaterial
    || typeof privateSignerMaterial !== 'object'
    || !privateSignerMaterial.privateKey
    || typeof privateSignerMaterial.signerKeyId !== 'string'
    || !qualificationKeyring
    || !isStockPreparationProvisioningDatabase(provisioningDatabase)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const ownedIdentityKey = Buffer.from(identityKey)
  const db = provisioningDatabase.db
  const lifecycle = createSealedExportLifecycleProvisioning({ db })

  return Object.freeze({
    async provisionInitial(rawSpec) {
      await provisioningDatabase.assertReady()
      if (
        !rawSpec
        || typeof rawSpec !== 'object'
        || !rawSpec.binding
        || !rawSpec.externalSystem
      ) {
        failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
      }
      const draft = Object.freeze({
        approvedConfigVersionId:
          rawSpec.binding.approvedConfigVersionId,
        bindingVersion: rawSpec.binding.bindingVersion,
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
        externalSystemId: rawSpec.binding.externalSystemId,
        objectKey: OBJECT_KEY,
        relationId: RELATION_ID,
        tableRef: rawSpec.binding.tableRef,
        tenantId: rawSpec.binding.tenantId,
        workspaceId: rawSpec.binding.workspaceId,
      })
      const resolution =
        deriveStockPreparationSqlServerSourceAnchors({
          binding: draft,
          externalSystem: rawSpec.externalSystem,
          identityKey: ownedIdentityKey,
        })
      const captureService = createSqlServerSealedSnapshotService({
        approvedBindings: [{
          approvedConfigVersionId: draft.approvedConfigVersionId,
          bindingVersion: draft.bindingVersion,
          canonicalObjectVersion: draft.canonicalObjectVersion,
          configContentKey: resolution.anchors.configContentKey,
          objectKey: draft.objectKey,
          relationId: draft.relationId,
          roleBindingFingerprint:
            resolution.anchors.roleBindingFingerprint,
          tableRef: draft.tableRef,
          tenantDomainBinding:
            resolution.anchors.tenantDomainBinding,
        }],
        artifactRoot,
        authorityDb: db,
        connectionConfig: resolution.connectionConfig,
        onReaderActive: null,
        privateSignerMaterials: [privateSignerMaterial],
        qualificationKeyring,
        stageObserver: null,
        systemContentKey: resolution.anchors.systemContentKey,
        tenantId: draft.tenantId,
        workspaceId: draft.workspaceId,
      })
      const qualification =
        await captureService.probeQualificationForBinding(OBJECT_KEY)
      captureService.verifyQualificationForBinding(
        OBJECT_KEY,
        qualification,
      )
      let publicKey
      try {
        publicKey = crypto.createPublicKey(
          privateSignerMaterial.privateKey,
        )
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      const provisioned =
        await lifecycle.provisionInitialStockPreparationBinding({
          authority: {
            bindingExpiresAt: rawSpec.binding.bindingExpiresAt,
            publicKey,
            qualificationDigest:
              qualification.qualificationDigest,
            qualificationExpiresAt: qualification.expiresAt,
            scope: {
              roleBindingFingerprint:
                resolution.anchors.roleBindingFingerprint,
              systemContentKey:
                resolution.anchors.systemContentKey,
              tenantDomainBinding:
                resolution.anchors.tenantDomainBinding,
              tenantId: draft.tenantId,
              workspaceId: draft.workspaceId,
            },
            signerExpiresAt: rawSpec.binding.signerExpiresAt,
          },
          binding: {
            ...draft,
            bindingId: rawSpec.binding.bindingId,
            configContentKey:
              resolution.anchors.configContentKey,
            expiresAt: rawSpec.binding.bindingExpiresAt,
            roleBindingFingerprint:
              resolution.anchors.roleBindingFingerprint,
            systemContentKey:
              resolution.anchors.systemContentKey,
            tenantDomainBinding:
              resolution.anchors.tenantDomainBinding,
          },
        })
      return Object.freeze({
        changed: provisioned.changed,
        externalWrite: false,
        qualificationCurrent: true,
        signerEnrolled: true,
        valuesFree: true,
      })
    },
  })
}

module.exports = Object.freeze({
  createStockPreparationRuntimeProvisioning,
})
