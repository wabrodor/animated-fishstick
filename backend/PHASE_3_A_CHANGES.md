# ApexCare Phase 3A Changes

## Scope

Phase 3A.1 establishes the first executable 90-day care-plan state layer on top of the Phase 3.0 execution/idempotency foundation.

This patch is intentionally limited to execution state, milestone transitions, stable task identity, read APIs, and security/idempotency coverage. It does not add WhatsApp, laboratory intelligence, appointment automation, adherence changes, or specialist workflows.

## File-by-file changes

### `care-plan-execution.ts`
- Added stable machine task-definition keys: `DAY_<day>:<TASK_TYPE>:<sequence>`.
- Added `getCarePlanExecution()` to return one execution with its milestones and tasks under the same tenant/patient/care-plan boundary.
- Added `transitionCarePlanMilestone()` with atomic state transitions.
- Completion before the milestone due date becomes `COMPLETED_EARLY`.
- Completion at/after the due date becomes `COMPLETED`.
- Explicit skip becomes `SKIPPED`.
- Repeating the same terminal command is idempotent.
- Terminal/conflicting transitions are rejected.
- Execution must be `ACTIVE` before milestone transitions are accepted.
- Existing execution bootstrap/outbox behavior remains intact.
- Existing task attachment now prefers a preassigned stable `taskKey`; otherwise it derives one from milestone day, task type, and sequence.

### `routes.ts`
- Added `milestoneId` route-parameter validation.
- Added optional `taskKey` to manually created care-plan tasks.
- Manual care-plan task creation now assigns stable task-definition keys when none are supplied.
- Added `GET /patients/:patientId/care-plans/:carePlanId/execution`.
- Added `PATCH /patients/:patientId/care-plans/:carePlanId/execution/milestones/:milestoneId` with `COMPLETE` and `SKIP` actions.
- Execution and milestone routes use the existing patient/organization access boundary.
- Only clinic admin, clinician, and clinic coordinator roles can operate these routes.

### `ai-care-plan.ts`
- AI-generated care-plan tasks now receive stable task-definition keys before insertion.
- ApexCare fallback-approved care-plan tasks use the same stable identity convention.

### `tests/phase3.0.test.ts`
- Updated task identity assertions for stable machine keys.
- Added stable-key/title-change coverage.
- Added early-completion/idempotency coverage.
- Added cancelled-execution transition protection.
- Added combined execution/milestone/task read coverage.

### `tests/security.test.ts`
- Added cross-clinic execution read isolation test.
- Added role boundary test for milestone mutation.
- Confirmed ApexCare doctor cannot mutate clinic execution state through the clinic route.
- Confirmed clinic coordinator can complete an accessible milestone.

## Architectural invariants preserved

- MongoDB remains the source of truth.
- Existing BullMQ/Redis architecture is reused.
- Existing durable outbox is reused; no second scheduler is introduced.
- Worker/event idempotency remains deterministic.
- Tenant context is required for execution and milestone queries.
- No autonomous clinical decision or medication change is introduced.
- No new microservice is introduced.

## Verification status

The environment used to prepare this patch does not contain a usable `node_modules` tree. `npm ci` timed out and local `tsc` cannot resolve the project's installed type definitions. Therefore this patch is intentionally delivered with tests added but without claiming local execution success.

Run in the project's normal environment:

```bash
npm ci
npm run typecheck
npx vitest run tests/phase3.0.test.ts tests/security.test.ts
npm test
```


## Phase 3A.2 protocol-driven execution architecture

### `models.ts`
- Added `CareProtocol` as a versioned database-backed protocol definition.
- Added protocol milestone definitions with stable keys and configurable `offsetDays`.
- Added `protocolKey` and `protocolVersion` to `CarePlanExecution` so each execution snapshots the protocol version used at activation.
- Added `offsetDays` to `CarePlanMilestone` and changed milestone uniqueness from `(executionId, day)` to `(executionId, key)` so multiple milestones can exist on the same day if a future protocol requires them.

### `care-protocol.ts` (new)
- Added protocol resolution by condition and optional version.
- Seeds the currently defined hypertension schedule as version `1.0` when no database record exists.
- Does not invent schedules for diabetes, dyslipidemia, or PCOS; those protocols require clinically approved definitions before activation.
- Database protocol records are the future source of truth for changing schedules without changing the execution engine.

### `care-plan-execution.ts`
- Removed the hard-coded seven-day schedule from execution creation.
- Execution milestones are now generated from the resolved protocol definition.
- Existing executions retain their protocol/version snapshot and are not silently migrated when a new protocol becomes active.
- Task-to-milestone association now resolves by protocol offset rather than a hard-coded day list.
- Stable task keys use the milestone key rather than the human-readable title/day alone.

### `queues.ts`
- Milestone jobs now carry `milestoneKey` and `offsetDays` in addition to legacy `day`.

### `outbox-dispatcher.ts`
- Passes protocol-driven milestone identity through to the deterministic BullMQ job payload.

### Important protocol-change rule
`models.ts` defines the database shape; it is not where clinicians should edit review dates. The schedule lives in `CareProtocol` records. A future protocol-management workflow can create a new version, for example `HYPERTENSION v2.0`, without rewriting existing executions.

## Protocol data model clarification

`models.ts` defines the shape and indexes of protocol data; clinicians should not edit review dates by editing TypeScript schema code. The actual schedule is stored in `CareProtocol` MongoDB documents. A future protocol-management UI or controlled seed/migration can publish a new version without changing the execution engine. Existing executions keep their `protocolKey` and `protocolVersion` snapshot.
