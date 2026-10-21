import { z } from 'zod'

export const PlatformCapabilitySchema = z.enum([
  'auth',
  'rbac',
  'multitable',
  'workflow',
  'approvals',
  'comments',
  'files',
  'notifications',
  'events',
  'plugins',
])

export const PlatformAppNavigationItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1),
  icon: z.string().optional(),
  order: z.number().int().optional(),
  location: z.enum(['main-nav', 'admin', 'hidden']).default('main-nav'),
})

export const PlatformAppRuntimeBindingsSchema = z.object({
  currentPath: z.string().min(1).optional(),
  installPath: z.string().min(1).optional(),
  installPayload: z.record(z.string(), z.unknown()).default({}),
})

/**
 * How a MANAGED multitable object is brought into existence.
 *
 * `idempotent` is a literal `true`, not a boolean: an installer re-runs every ensure on every
 * install, so an object whose creation is not idempotent cannot be declared here at all.
 */
export const PlatformAppObjectEnsureSchema = z.object({
  idempotent: z.literal(true),
  method: z.enum(['POST']).default('POST'),
  path: z.string().min(1),
  /** Literal request body, for an ensure whose target id is fixed. */
  body: z.record(z.string(), z.unknown()).optional(),
  /** `{ bodyField: 'configSurfaceId.field' }`, for an ensure whose target id comes from config. */
  bodyFrom: z.record(z.string(), z.string()).optional(),
  permission: z.string().min(1).optional(),
})

/**
 * MULTITABLE-BACKED objects (`backing: 'multitable'`) may additionally declare the identity the
 * installer must use. Every field here is OPTIONAL, so the manifests that predate it — after-sales
 * already declares five `backing: 'multitable'` objects — parse to exactly the same value as before.
 *
 * `objectIdPolicy` is what turns a declaration into a managed one, and it admits two forms, both of
 * which say the same thing: THE OBJECT ID IS NEVER INVENTED PER DEPLOYMENT.
 *
 *   'fixed'       — the id is a constant, spelled here (`objectId`).
 *   'from-config' — the id comes from a named field of a named config surface (`objectIdFrom`), and
 *                   must fall inside `objectIdNamespace`, which the server independently enforces.
 *
 * The second form exists because a sandbox target's concrete id legitimately differs per deployment
 * while the NAMESPACE does not. Hard-coding one sandbox id in a manifest would be the very mistake
 * the policy is here to prevent.
 */
export const PlatformAppObjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    backing: z.enum(['multitable', 'service', 'hybrid']).default('service'),
    objectIdPolicy: z.enum(['fixed', 'from-config']).optional(),
    objectId: z.string().min(1).optional(),
    objectIdNamespace: z.string().min(1).optional(),
    objectIdFrom: z
      .object({
        configSurface: z.string().min(1),
        field: z.string().min(1),
      })
      .optional(),
    displayNames: z.record(z.string(), z.string()).optional(),
    columnCount: z.number().int().positive().optional(),
    ensure: PlatformAppObjectEnsureSchema.optional(),
    note: z.string().optional(),
  })
  .superRefine((object, ctx) => {
    if (object.objectIdPolicy === undefined) return
    if (object.backing !== 'multitable') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectIdPolicy'],
        message: 'objectIdPolicy is only meaningful for a multitable-backed object',
      })
    }
    if (object.ensure === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ensure'],
        message: 'a managed object must declare the idempotent ensure that creates it',
      })
    }
    if (object.objectIdPolicy === 'fixed' && !object.objectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectId'],
        message: "objectIdPolicy 'fixed' requires the objectId itself",
      })
    }
    if (object.objectIdPolicy === 'from-config') {
      if (!object.objectIdNamespace) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['objectIdNamespace'],
          message: "objectIdPolicy 'from-config' requires the namespace the configured id must fall inside",
        })
      }
      if (!object.objectIdFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['objectIdFrom'],
          message: "objectIdPolicy 'from-config' requires the config surface and field the id is read from",
        })
      }
    }
  })

/**
 * A CONFIG SURFACE is deployment data the app needs but the repository must never carry: a customer
 * pack, a field mapping, an env allowlist. `committed` is a literal `false` — there is no way to
 * declare a config surface that lives in the repo.
 */
export const PlatformAppConfigSurfaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['deployment-data-file', 'env-allowlist']),
  /** The env var naming the server-side file, for `deployment-data-file`. */
  envVar: z.string().min(1).optional(),
  /** The env vars carrying the values directly, for `env-allowlist`. */
  envVars: z.array(z.string().min(1)).min(1).optional(),
  serverConfigKey: z.string().min(1).optional(),
  committed: z.literal(false),
  note: z.string().min(1),
})

/** One machine-checkable assertion inside an acceptance criterion. */
export const PlatformAppAcceptanceAssertionSchema = z.object({
  scope: z.enum(['target-rows', 'dry-run-plan']),
  columns: z.enum(['mapped-ext', 'human-preserved']).optional(),
  predicate: z.enum(['some-non-empty', 'all-empty', 'all-actions-skip']),
  minMatchingRows: z.number().int().positive().optional(),
  run: z.number().int().positive().optional(),
})

/**
 * ACCEPTANCE — the definition of "installed", stated so a harness can check it rather than a human
 * reading prose. `verifiedBy.script` names the harness that already asserts these criteria.
 */
export const PlatformAppAcceptanceSchema = z.object({
  verifiedBy: z.object({
    script: z.string().min(1),
    note: z.string().optional(),
  }),
  runbook: z.string().min(1).optional(),
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        statement: z.string().min(1),
        after: z.array(z.string().min(1)).optional(),
        assertions: z.array(PlatformAppAcceptanceAssertionSchema).min(1),
      })
    )
    .min(1),
})

/**
 * POSTURE — fences the app REPORTS and never installs.
 *
 * The entry object is `.strict()` on purpose. A posture entry carrying anything beyond an id, its
 * expected state, a human sentence and (optionally) the env var it is read from is a schema ERROR,
 * so a `fix` / `enable` / `run` key cannot be added to a posture entry at all: the manifest stops
 * parsing. `mode` and `installerMayModify` are literals for the same reason — there is no other
 * value they may take.
 */
export const PlatformAppPostureSchema = z
  .object({
    mode: z.literal('reported-not-installed'),
    installerMayModify: z.literal(false),
    note: z.string().min(1),
    entries: z
      .array(
        z
          .object({
            id: z.string().min(1),
            expectedState: z.string().min(1),
            what: z.string().min(1),
            envVar: z.string().min(1).optional(),
          })
          .strict()
      )
      .min(1),
  })
  .strict()

export const PlatformAppWorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.string().optional(),
})

export const PlatformAppIntegrationSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['http', 'plm', 'webhook', 'manual']),
  direction: z.enum(['inbound', 'outbound', 'bidirectional']).default('bidirectional'),
})

/**
 * WHO MAY HOLD an app's permission codes the moment it is installed.
 *
 * `automaticHolders` is normally the empty array, and saying so explicitly is the point: a reader
 * of the manifest should not have to infer "nobody" from silence.
 */
export const PlatformAppPermissionPolicySchema = z.object({
  automaticHolders: z.array(z.string()),
  seededBy: z.string().optional(),
  source: z.string().optional(),
  note: z.string().min(1),
})

/**
 * The application manifest.
 *
 * THE THREE IDENTITY LAYERS, kept apart on purpose:
 *   `id`             immutable — it is in code, routes and documents, and renaming it breaks them
 *   `displayName`    the name people read; a deployment or a customer may change it
 *   `valueStatement` one line saying what the app does for whoever reads that name
 *
 * Everything added after `integrations` is OPTIONAL, so every manifest written before those fields
 * existed parses to exactly the same value it did before.
 */
export const PlatformAppManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  valueStatement: z.string().min(1).optional(),
  pluginId: z.string().min(1).optional(),
  runtimeModel: z.enum(['instance', 'direct']).default('instance'),
  boundedContext: z.object({
    code: z.string().min(1),
    owner: z.string().optional(),
    description: z.string().optional(),
  }),
  runtimeBindings: PlatformAppRuntimeBindingsSchema.optional(),
  platformDependencies: z.array(PlatformCapabilitySchema).default([]),
  navigation: z.array(PlatformAppNavigationItemSchema).default([]),
  permissions: z.array(z.string()).default([]),
  featureFlags: z.array(z.string()).default([]),
  objects: z.array(PlatformAppObjectSchema).default([]),
  workflows: z.array(PlatformAppWorkflowSchema).default([]),
  integrations: z.array(PlatformAppIntegrationSchema).default([]),
  permissionPolicy: PlatformAppPermissionPolicySchema.optional(),
  configSurfaces: z.array(PlatformAppConfigSurfaceSchema).optional(),
  acceptance: PlatformAppAcceptanceSchema.optional(),
  posture: PlatformAppPostureSchema.optional(),
})

export type PlatformCapability = z.infer<typeof PlatformCapabilitySchema>
export type PlatformAppNavigationItem = z.infer<typeof PlatformAppNavigationItemSchema>
export type PlatformAppRuntimeBindings = z.infer<typeof PlatformAppRuntimeBindingsSchema>
export type PlatformAppObject = z.infer<typeof PlatformAppObjectSchema>
export type PlatformAppObjectEnsure = z.infer<typeof PlatformAppObjectEnsureSchema>
export type PlatformAppConfigSurface = z.infer<typeof PlatformAppConfigSurfaceSchema>
export type PlatformAppAcceptance = z.infer<typeof PlatformAppAcceptanceSchema>
export type PlatformAppPosture = z.infer<typeof PlatformAppPostureSchema>
export type PlatformAppPermissionPolicy = z.infer<typeof PlatformAppPermissionPolicySchema>
export type PlatformAppWorkflow = z.infer<typeof PlatformAppWorkflowSchema>
export type PlatformAppIntegration = z.infer<typeof PlatformAppIntegrationSchema>
export type PlatformAppManifest = z.infer<typeof PlatformAppManifestSchema>

export function definePlatformApp(manifest: PlatformAppManifest): PlatformAppManifest {
  return manifest
}

export function parsePlatformAppManifest(raw: unknown): PlatformAppManifest {
  return PlatformAppManifestSchema.parse(raw)
}
