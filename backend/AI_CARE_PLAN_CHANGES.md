# Hypertension AI Care Plan Update

## Added

- `ai-care-plan.ts`: structured hypertension draft generator.
- `CarePlanDraft` MongoDB collection to keep AI/rules drafts separate from approved clinical plans.
- Clinician-only endpoints to generate, list, approve, and reject drafts.
- Strict structured AI output with bounded fields and allowed task types.
- AI prompt explicitly forbids diagnosis, medication prescribing, medication changes, and invented facts.
- Direct identifiers are excluded from the AI request payload.
- Safe rules-based fallback when AI is disabled or the provider is unavailable; the stored source is marked `RULES` rather than `AI`.
- Approval converts the draft into an active 90-day care plan and creates care tasks.
- Care-task reminders are scheduled after approval.
- One-active-hypertension-care-plan database constraint.
- Audit fields for generated/approved/rejected drafts.

## Workflow

1. Assigned clinician calls `POST /patients/:patientId/hypertension/care-plan-drafts`.
2. Server gathers structured clinical data from MongoDB.
3. AI receives a de-identified structured snapshot when enabled.
4. Server normalizes and bounds the AI response before storing it.
5. Clinician reviews the draft.
6. Clinician either rejects it or approves it.
7. Approval creates the active care plan and its tasks.
8. The system schedules task reminders.

## Important safety boundary

AI is decision support only. It cannot activate a plan, prescribe medication, change medication, diagnose the patient, or modify clinical data without an authenticated clinician action.


## Phase 2E asynchronous workflow

- Dietitian assessment requires `coordinatorCallStatus=CONTACTED`.
- Care-plan generation is queued through BullMQ instead of running in the HTTP request.
- The dietitian endpoint returns HTTP 202 with the queued job id.
- The AI worker creates the draft, links it to the ApexCare enrollment, moves the patient to `CARE_PLAN_REVIEW`, and schedules the existing 24-hour clinician review SLA.
- If queue submission fails, the dietitian assessment is rolled back to `PENDING`.
