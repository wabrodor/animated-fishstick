# Phase 2E — Idempotency & Worker Hardening

## Why this revision exists

The first Phase 2E implementation queued care-plan generation but did not provide a production-grade idempotency contract for repeated HTTP requests, BullMQ retries, partial persistence, or worker tenant context.

## Hardened design

### 1. One assessment per ApexCare enrollment
- `DietitianAssessment.apexCareEnrollmentId` is the workflow identity.
- A sparse unique index prevents duplicate assessments for the same enrollment.
- Concurrent POST requests converge on the existing assessment.

### 2. Explicit generation state
`ApexCareEnrollment.carePlanGenerationStatus`:

`NOT_STARTED → QUEUED → PROCESSING → COMPLETED`

Failure is represented by `FAILED`, which permits a controlled retry.

### 3. Attempt-scoped BullMQ identity
Job identity is:

`hypertension-draft-{enrollmentId}-{assessmentId}-{attempt}`

The previous patient-only job ID is intentionally removed. A retry receives a new attempt number without creating another assessment.

### 4. Complete tenant context
Every generation job contains:
- patientId
- clinicOrganizationId
- apexcareOrganizationId
- clinicianId
- enrollmentId
- assessmentId
- attempt

The worker and generator validate all relevant boundaries before processing.

### 5. Worker revalidation
Before generation the worker verifies:
- active ApexCare enrollment
- clinic/ApexCare tenant match
- coordinator status is `CONTACTED`
- dietitian assessment is complete and belongs to the enrollment
- patient is active
- assigned clinician still matches the job

### 6. Partial-success recovery
Before creating a draft, the generator checks for an existing `CLINICIAN_REVIEW` draft. The database unique index remains the final duplicate barrier. A duplicate-key race is resolved by reading the existing draft instead of failing the workflow.

If a draft was persisted but the worker crashed before updating the enrollment, a retry discovers the draft and converges on it.

### 7. BullMQ failure semantics
Generation errors are thrown from the worker. They are not logged-and-returned as successful jobs.

- transient failures use BullMQ retries
- permanent context failures use `UnrecoverableError`
- terminal failure marks the enrollment generation state `FAILED`

### 8. Automated coverage
Phase 2E tests cover:
- coordinator-contact prerequisite
- one assessment / one queued job
- repeated client submission returns the existing assessment/job
- failed generation retry increments the attempt without creating another assessment
- existing Phase 2D tenant/security coverage remains in place

## Operational rule

Do not deploy Phase 2E without running the full test suite against the production-equivalent MongoDB/Redis versions. The application should treat the database uniqueness constraints and BullMQ job IDs as part of the idempotency contract, not merely as defensive checks.
