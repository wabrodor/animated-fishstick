# Phase 3.0 — Execution / Idempotency Foundation

Baseline: Phase 2E idempotency-hardened backend.

## Changed files

### `models.ts`
- Added `CarePlanExecution`.
- Added `CarePlanMilestone` with unique `(executionId, day)` identity.
- Extended `CareTask` with optional `executionId`, `milestoneId`, and deterministic `taskKey`.
- Added a unique partial index on `(executionId, taskKey)` so retries/concurrent task projection cannot create duplicate logical tasks.
- Added `OutboxEvent` with unique `eventKey`, durable status, attempts, availability time, and error state.

### `care-plan-execution.ts` — new
- Defines the canonical Phase 3 milestone days: 0, 3, 7, 14, 30, 60, 90.
- Creates/reuses exactly one execution per care plan.
- Uses an upsert + duplicate-key recovery path for concurrent execution creation.
- Creates milestones with idempotent upserts.
- Attaches existing care tasks to the execution and matching milestone.
- Generates deterministic task keys.
- Preserves tenant boundaries in every lookup/update.

### `outbox.ts` — new
- Idempotent `enqueueOutboxEvent` using a unique logical event key.
- Added claim/publish/failure primitives for the future durable outbox dispatcher.
- The dispatcher itself is intentionally deferred to the next execution step; this foundation is not silently wired into unrelated Phase 2 flows yet.

### `queues.ts`
- Added deterministic `scheduleCarePlanMilestone` job helper.
- Uses execution + milestone identity as the BullMQ job ID.

### `ai-care-plan.ts`
- Approved clinician and ApexCare-doctor care-plan creation now creates a `CarePlanExecution` and its seven milestones.
- Existing generated tasks are attached to the execution/matching milestone.
- Cleanup now removes care-plan tasks if execution bootstrap fails, preventing orphaned Phase 2 tasks.

### `routes.ts`
- Manual care-plan creation now also bootstraps the execution/milestone layer and attaches its tasks.

### `tests/phase3.0.test.ts` — new
- One execution per care plan.
- Seven deterministic milestones.
- Concurrent execution creation safety.
- Cross-organization isolation.
- Task-to-milestone attachment.
- Duplicate outbox event protection.

## Intentionally NOT changed yet
- WhatsApp/App notifications.
- Laboratory processing.
- Appointment scheduling.
- Patient review workflow.
- Coordinator adherence escalation.
- Clinical timeline.
- Existing Phase 2 prescription/clinical-review workers.

These remain Phase 3B–3F work.

## Test fixes after first local validation
- `tests/phase3.0.test.ts`: explicitly await unique index initialization before asserting duplicate-task rejection. This makes the database-level uniqueness test deterministic rather than depending on Mongoose's background index build timing.
- `tests/security.test.ts`: the Phase 2E retry test now measures the scheduler spy relative to its pre-test call count, so shared mock history cannot make the test fail. The assertion also inspects the newly appended retry call.
- No production behavior was changed for either failure; both failures were test/setup issues.

## Phase 3.0 hardening — durable outbox publication
- Extended `OutboxEvent` with `processingStartedAt` so a crashed dispatcher can reclaim a stale `PROCESSING` event after a 60-second lease.
- Added `outbox-dispatcher.ts` to claim pending/stale events, publish deterministic care-plan milestone jobs to BullMQ, mark successful publication as `PUBLISHED`, and return failed publication to `PENDING` with backoff metadata.
- Wired the worker process to run the outbox dispatcher every second and stop it during graceful shutdown.
- `ensureCarePlanExecution()` now creates deterministic `CARE_PLAN_MILESTONE_DUE` outbox events for all seven milestones and reuses them on repeated execution bootstrap.
- Added tests for durable milestone event creation, repeated bootstrap idempotency, successful publication, and publication failure recovery state.
- Existing Phase 2 direct queue paths were not migrated in this targeted hardening patch; the new Phase 3 execution path uses the durable outbox for milestone scheduling.


## Phase 3.0 hardening — adaptive outbox polling
- Replaced the fixed 1-second outbox polling interval with a non-overlapping adaptive loop.
- Polls every second while events are being processed, backs off to 5 seconds when idle, and caps idle/error polling at 30 seconds.
- Prevents overlapping dispatcher cycles and reduces unnecessary MongoDB reads during quiet periods.
- Graceful shutdown now cancels the pending timeout and prevents another dispatcher cycle from being scheduled.


### Test determinism follow-up
- `tests/phase3.0.test.ts`: fixed two outbox tests that used a fixed historical clock while `enqueueOutboxEvent()` correctly defaults `availableAt` to the real current time. The tests now explicitly set `availableAt` to the injected test clock before dispatch/claim assertions. No production outbox behavior was changed.
