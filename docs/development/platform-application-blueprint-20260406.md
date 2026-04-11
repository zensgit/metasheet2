# Platform Application Blueprint

## Why this exists

The current repository already has the main building blocks for a multi-business platform:

- microkernel-style plugin loading
- multitable as a generic data surface
- approval and workflow engines
- RBAC and admin controls

What is still missing is a clean separation between:

- platform primitives
- business applications
- plugin extensions

This document defines a low-conflict execution path while `attendance`, `multitable`, and `approvals` are actively being developed in parallel.

## Current platform mapping

### Platform primitives that already exist

- Data primitive: multitable
- Process primitive: workflow + approvals
- Access primitive: auth + RBAC
- Extension primitive: plugin loader + plugin admin
- Integration primitive: federation / external adapters

### Business modules already visible in the repo

- Attendance: plugin-first business module
- Multitable: platform-owned core primitive
- Approvals / workflow: platform-owned core primitive
- PLM views / bridges: mixed platform and business integration layer

## Target layering

```text
tenant / org / user / role
  -> platform shell
  -> platform primitives
     -> multitable
     -> workflow
     -> approvals
     -> comments
     -> files
     -> notifications
     -> events
  -> business applications
     -> attendance
     -> after-sales
     -> purchasing
     -> equipment
  -> plugin extensions
     -> connectors
     -> custom pages
     -> custom automation
```

## Execution policy during concurrent development

Because the local worktree already contains unrelated changes in `attendance`, `multitable`, and `approvals`, phase 1 must avoid direct edits in those domains.

Phase 1 safe change scope:

- new documentation
- new platform manifest definitions
- new business app skeletons
- minimal frontend plugin host generalization

Do not change in phase 1:

- existing attendance business logic
- multitable record / field / view behavior
- approval bridge implementation
- platform startup / plugin runtime internals unless absolutely required

## Platform primitive contract

Business applications should prefer composition over bespoke infrastructure.

### Data

- Use multitable for configurable object storage first
- Add service-owned tables only when the domain needs strict transactional or performance boundaries
- Treat multitable as the default UI-facing schema layer

### Process

- Reuse workflow for long-running orchestration
- Reuse approvals for human decision points
- Avoid embedding approval state machines independently inside each business app

### Access

- Add app-scoped RBAC permissions such as `after_sales:read`
- Keep platform-level admin separate from app-level admin

### Extension

- Use plugins for business-specific routes, sync jobs, connectors, or specialized pages
- Do not use plugins as a substitute for platform primitives

## App manifest model

Every business application should eventually declare:

- identity
- bounded context ownership
- platform dependencies
- navigation entries
- app permissions
- domain objects
- workflows
- external integrations

This repo now includes a first `PlatformAppManifest` schema plus an `after-sales` example skeleton.

## After-sales application shape

The recommended `after-sales` bounded context is:

- tickets
- service orders
- customers
- installed assets
- warranty policies
- service visits
- closure / satisfaction feedback

Recommended implementation split:

- multitable for customer-facing objects and configurable data views
- workflow / approvals for dispatch, escalation, refund, replacement, or exception handling
- plugin code for SLA calculation, connector sync, specialized APIs, and dedicated UI pages

## Phase 1 deliverables

1. Add a platform app manifest schema
2. Generalize the frontend plugin host to resolve more than one plugin page
3. Scaffold `plugin-after-sales`
4. Keep all changes isolated from active attendance / multitable / approvals work

## Next phases

### Phase 2

- add backend loader support for `app.manifest.json`
- expose platform apps through an `/api/apps` endpoint
- bind app manifests to feature flags and RBAC

### Phase 3

- route app objects to multitable metadata
- route app workflows to workflow designer templates
- route app approvals to unified approval flows

### Phase 4

- strengthen runtime isolation for plugins
- make frontend app pages dynamically discoverable
- add app marketplace / version governance
