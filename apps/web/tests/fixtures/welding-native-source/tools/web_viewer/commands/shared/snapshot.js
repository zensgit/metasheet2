// Snapshot / undo-redo command infrastructure extracted from command_registry.js
// (P2 workbench split, S3). Behavior-preserving move: these helpers are the
// snapshot capture/restore seam that every mutating command wraps itself in via
// withSnapshot. Kept as their own module so later command-domain extractions can
// import the seam without pulling the full registry. Bodies are unchanged.
import { commandResult } from '../command_bus.js';

export function nowMs() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function emitPerfProfile(ctx, profile) {
  const hook = ctx?.__perfHooks?.onSnapshotProfile;
  if (typeof hook !== 'function') return;
  try {
    hook(profile);
  } catch {
    // Ignore perf hook failures; command behavior must stay deterministic.
  }
}

export function captureState(ctx) {
  return {
    // snapshot()/toJSON() already return detached data; avoid duplicate deep-clone here.
    document: ctx.document.snapshot(),
    selection: ctx.selection.toJSON(),
    snap: ctx.snap.toJSON(),
    view: ctx.viewport.toJSON(),
  };
}

export function restoreState(ctx, snapshot) {
  ctx.document.restore(snapshot.document);
  ctx.selection.restore(snapshot.selection);
  ctx.snap.restore(snapshot.snap);
  ctx.viewport.restore(snapshot.view);
}

export function withSnapshot(ctx, id, mutator) {
  const tBefore = nowMs();
  const before = captureState(ctx);
  const beforeMs = nowMs() - tBefore;
  emitPerfProfile(ctx, { commandId: id, phase: 'before', ms: beforeMs });

  const tMutator = nowMs();
  const outcome = mutator();
  const mutatorMs = nowMs() - tMutator;
  emitPerfProfile(ctx, { commandId: id, phase: 'mutator', ms: mutatorMs });

  if (!outcome.ok) {
    return commandResult(false, false, {
      message: outcome.message,
      error_code: outcome.error_code || 'COMMAND_FAILED',
    });
  }
  if (!outcome.changed) {
    return commandResult(true, false, {
      message: outcome.message || `${id}: no changes`,
    });
  }

  const tAfter = nowMs();
  const after = captureState(ctx);
  const afterMs = nowMs() - tAfter;
  emitPerfProfile(ctx, { commandId: id, phase: 'after', ms: afterMs });

  return commandResult(true, true, {
    message: outcome.message || `${id}: applied`,
    undo: () => restoreState(ctx, before),
    redo: () => restoreState(ctx, after),
  });
}
