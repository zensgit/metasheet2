/**
 * Who changed which field of a merged realtime write.
 *
 * Several connections can contribute to one merged write. Each field of the write is checked against
 * every actor that changed it, and against nobody else: an actor is not held to a restriction on a
 * field it did not touch, and no actor borrows the permission of another. A field that no
 * contribution record names is checked against the flushing actor.
 */
import type { YjsContribution } from './yjs-record-bridge'

/** For every field of the write, the distinct actors that changed it (the flushing actor when none is recorded). */
export function writersByField(
  fieldIds: readonly string[],
  flushingActorId: string,
  contributions: readonly YjsContribution[] | undefined,
): Map<string, string[]> {
  const writers = new Map<string, string[]>()
  for (const fieldId of fieldIds) {
    const actors = new Set<string>()
    for (const contribution of contributions ?? []) {
      if (contribution.fieldIds.includes(fieldId)) actors.add(contribution.actorId)
    }
    writers.set(fieldId, actors.size > 0 ? [...actors] : [flushingActorId])
  }
  return writers
}

/**
 * Loads the field permissions of every actor that changed a field of the write and returns, per
 * field, the permission maps it has to pass: one per actor that changed it. The permissions of the
 * flushing actor are passed in; those of every other writer are loaded once each.
 */
export async function fieldPermissionsOfWriters<P>(
  fieldIds: readonly string[],
  flushingActorId: string,
  flushingActorPermissions: P,
  contributions: readonly YjsContribution[] | undefined,
  loadFor: (actorId: string) => Promise<P>,
): Promise<(fieldId: string) => P[]> {
  const writers = writersByField(fieldIds, flushingActorId, contributions)
  const byActor = new Map<string, P>([[flushingActorId, flushingActorPermissions]])
  for (const actors of writers.values()) {
    for (const actorId of actors) {
      if (!byActor.has(actorId)) byActor.set(actorId, await loadFor(actorId))
    }
  }
  return (fieldId: string) => (writers.get(fieldId) ?? [flushingActorId]).map((actorId) => byActor.get(actorId) as P)
}
