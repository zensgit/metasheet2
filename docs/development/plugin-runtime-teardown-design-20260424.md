# Plugin Runtime Teardown Design - 2026-04-24

## Objective

Close the two host-runtime gaps exposed by `plugin-integration-core` M0 before M1 adds long-lived pipeline routes and communication APIs:

- stale plugin HTTP handlers stayed reachable after plugin deactivation;
- stale communication namespaces stayed in `pluginApis` after plugin deactivation or failed activation.

## Design

`MetaSheetServer` now owns plugin runtime registrations instead of relying on plugin code to clean itself up.

### Plugin-Owned Routes

`createPluginContext()` now overrides `context.api.http` for plugin contexts. Calls to `addRoute()` go through `registerPluginRoute(pluginName, method, path, handler)`.

The host stores each route registration with:

- owning plugin name;
- method and path;
- an `active` flag captured by the Express wrapper.

Express does not support cheap physical route removal from the mounted stack. Instead, deactivation marks plugin wrappers inactive. Inactive wrappers call `next()`, which makes the old handler behaviorally dead and lets a later reactivation register the same path behind it.

### Communication Namespaces

`context.communication.register()` now records namespace ownership. Deactivation and failed activation remove all namespaces owned by that plugin from `pluginApis`.

Namespace ownership is exclusive. If a second plugin tries to register a namespace already owned by another active plugin, activation fails and the original namespace stays intact. This avoids a cleanup bug where a failed or later-deactivated plugin could delete a namespace it did not own.

The runtime also exposes optional `communication.unregister(name)` for explicit plugin-side cleanup, but host-owned cleanup is the safety net.

### Lifecycle Hooks

`activatePluginInstance()` now cleans stale registrations before activation and again on activation failure.

`deactivatePluginByName()` now calls plugin `deactivate()` and then always cleans host-owned route and communication registrations. If plugin `deactivate()` throws, the plugin is still disabled and host registrations are still removed; the runtime state remains `failed` with the thrown error.

## Non-Goals

- No physical mutation of Express internal route stacks.
- No changes to core non-plugin `CoreAPI.http.addRoute()` behavior.
- No persistence of plugin runtime registration state.
- No change to plugin manifest format.
- No implementation of the remaining `services.security` injection gap.

## Follow-Up

- Add a full `MetaSheetServer` hot-load smoke for `plugin-integration-core` once local/CI DB and listener prerequisites are stable enough to run it consistently.
- Wire `services.security` into the runtime plugin context so credential storage can move from self-contained crypto to a host service.
