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

export const PlatformAppObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  backing: z.enum(['multitable', 'service', 'hybrid']).default('service'),
})

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

export const PlatformAppManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
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
})

export type PlatformCapability = z.infer<typeof PlatformCapabilitySchema>
export type PlatformAppNavigationItem = z.infer<typeof PlatformAppNavigationItemSchema>
export type PlatformAppRuntimeBindings = z.infer<typeof PlatformAppRuntimeBindingsSchema>
export type PlatformAppObject = z.infer<typeof PlatformAppObjectSchema>
export type PlatformAppWorkflow = z.infer<typeof PlatformAppWorkflowSchema>
export type PlatformAppIntegration = z.infer<typeof PlatformAppIntegrationSchema>
export type PlatformAppManifest = z.infer<typeof PlatformAppManifestSchema>

export function definePlatformApp(manifest: PlatformAppManifest): PlatformAppManifest {
  return manifest
}

export function parsePlatformAppManifest(raw: unknown): PlatformAppManifest {
  return PlatformAppManifestSchema.parse(raw)
}
