# ApexCare API v2 — Hypertension Workflow

Clean TypeScript/Express/MongoDB backend for the ApexCare clinic-native chronic-care programme.

## Canonical hypertension workflow

1. **Clinician diagnoses hypertension.** Diagnosis is recorded separately and is always attributed to the clinician.
2. **Coordinator/nurse enrols the patient.** The coordinator confirms ApexCare programme consent; consent is stored as an auditable `ProgramConsent` record.
3. **Minimum data only.** Enrolment does not require a large clinical questionnaire. Missing information remains unknown.
4. **BullMQ queues AI care-plan generation.** The patient moves to `CARE_PLAN_REVIEW` and the assigned clinician receives a draft when the worker completes.
5. **Clinician reviews the AI draft.** The clinician can approve or reject it. AI never activates a care plan.
6. **Approval creates the active 90-day hypertension care plan and care tasks.** Reminder jobs are then scheduled.
7. **Coordinator records OPD vitals and completes tasks.** Vitals and OPD visits remain separate collections.
8. **Clinician reviews progress and adjusts the plan.** Assigned-clinician authorization is enforced.
9. **Clinic can request ApexCare services.** Dietitian and endocrinology services are provided by ApexCare; clinics cannot create those accounts.

## Sparse-data / hospital-rush design

The system is deliberately progressive-data. A patient can enter the programme with only the information available during a busy OPD encounter. The AI context engine records what is known and what is missing and is instructed never to invent missing facts.

The AI payload contains structured clinical facts only; direct identifiers such as patient name, phone number and MRN are excluded.

## Key models

- `Patient` — clinic patient and programme state.
- `Diagnosis` — clinician-confirmed diagnosis history.
- `ProgramConsent` — auditable ApexCare programme consent.
- `VitalRecord` — separate longitudinal vitals collection.
- `OpdVisit` — separate OPD encounter collection.
- `CarePlanDraft` — AI/rules draft awaiting clinician review.
- `CarePlan` — clinician-approved active plan.
- `CareTask` — operational care tasks and completion history.
- `ServiceCase` — clinic requests to ApexCare dietitians/specialists.

## Important endpoints

### Diagnosis

- `POST /patients` — **clinician only**; creates the clinic patient record with a confirmed hypertension diagnosis.
- `POST /patients/:patientId/diagnoses` — **assigned clinician only**; records a confirmed hypertension diagnosis for an existing unenrolled patient.
- `GET /patients/:patientId/diagnoses`

### Programme enrolment

- `POST /patients/:patientId/enrol` — **clinic coordinator/nurse only**; requires confirmed clinician diagnosis and explicit programme consent.

Example:

```json
{
  "communicationConsent": true,
  "consentMethod": "VERBAL",
  "consentVersion": "2026-08-v1"
}
```

The endpoint returns `202 Accepted` because AI generation is asynchronous.

### AI care-plan draft

- `POST /patients/:patientId/hypertension/care-plan-drafts` — assigned clinician can manually request a draft.
- `GET /patients/:patientId/hypertension/care-plan-drafts`
- `PATCH /patients/:patientId/hypertension/care-plan-drafts/:draftId/approve`
- `PATCH /patients/:patientId/hypertension/care-plan-drafts/:draftId/reject`

After coordinator enrolment, the draft is generated automatically by BullMQ and enters `CLINICIAN_REVIEW`.

### Clinical workflow

- `POST|GET /patients/:patientId/vitals`
- `POST|GET /patients/:patientId/opd-visits`
- `PATCH /care-tasks/:taskId/complete`
- `GET /care-queue`
- `GET /patients/:patientId/hypertension/progress-summary`
- `GET /patients/:patientId/care-plans`

### ApexCare services

- `POST|GET /patients/:patientId/service-cases`
- `GET /apexcare/service-cases`
- `PATCH /apexcare/service-cases/:caseId/assign`
- `PATCH /apexcare/service-cases/:caseId/status`

Clinic staff can request ApexCare dietitian/endocrinology support, but only ApexCare roles can manage ApexCare provider assignments.

## Run locally

1. Copy `.env.example` to `.env` and set a strong JWT secret.
2. Start MongoDB and Redis: `docker compose up -d mongo redis`.
3. Install dependencies: `npm install`.
4. Start the API: `npm run dev`.
5. Start the worker in another terminal: `npm run worker`.

The API listens on `http://localhost:5000/api/v1`.

## AI configuration

AI is disabled by default:

```env
AI_ENABLED=false
```

Enable it only after the applicable privacy, consent, data-processing, security and vendor requirements have been reviewed:

```env
AI_ENABLED=true
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=...
AI_MODEL=...
```

If AI is disabled or unavailable, the system creates a clearly labelled `RULES` baseline draft so the workflow remains operational and testable.

## Security rules

- JWTs are validated with issuer, audience and algorithm restrictions.
- Active user and organization status are rechecked against MongoDB on every authenticated request.
- Login and organization registration are rate limited.
- API responses are `Cache-Control: no-store`.
- All clinic clinical queries are organization-scoped.
- Clinicians are restricted to their assigned patients for clinical reads/writes and care-plan operations.
- Coordinators cannot diagnose or approve care plans.
- Clinic admins cannot create ApexCare dietitian/specialist accounts.
- Diagnosis and consent are auditable records.
- AI receives structured clinical context without direct patient identifiers.
- AI cannot activate plans, diagnose patients, prescribe medication, or change treatment.
- Invalid object IDs are rejected before database queries.
- Password hashes and authorization headers are excluded from application responses/logging.

## Verification

Run locally after dependencies are available:

```bash
npm ci
npm run typecheck
npm run build
```

Then run an integration test covering:

```text
Clinician diagnosis
→ Coordinator consent + enrolment
→ BullMQ AI draft
→ Clinician review
→ Approve
→ Care tasks
→ Vitals
→ OPD
→ Progress summary
→ ApexCare service request
```

Also test cross-clinic access and role-boundary failures before any production clinical use.

## ApexCare implementation phase roadmap

The agreed implementation sequence is intentionally incremental:

1. **Phase 1 — Security and organization boundaries**: authentication/authorization, clinic vs ApexCare tenancy, assigned-clinician boundaries, ApexCare service-case boundaries, and security regression coverage.
2. **Phase 2A — Referral, enrollment, consent, prescription capture, and SLAs**: clinician referral, clinic staff capture/enrollment, consent, prescription document capture, 12-hour clinic referral escalation, and 24-hour coordinator-call SLA.
3. **Phase 2B — Image-first prescription AI**: private original prescription storage, asynchronous vision extraction, staff review/edit, second AI verification, discrepancy detection, and failure-to-clinical-review safety boundaries.
4. **Phase 2C — Medication state and worker architecture**: verified `MedicationRecord`, immutable `MedicationHistory`, asynchronous prescription analysis/verification workers, and prevention of medication finalization from unverified drafts.
5. **Phase 2D — Clinical review and escalation (current)**: dedicated clinical-review cases, assigned clinic clinician review, 24-hour escalation to ApexCare doctor, immutable review events, protocol-safe ApexCare approval, and a hard finalization gate while review is unresolved.
6. **Phase 3 / 3C — Specialist and general-medicine escalation (later)**: reuse the existing `ServiceCase` specialist workflow, add clinician-only general-medicine doubt clearance, clinic staff scheduling/coordination, and keep teleconsultation as an architectural option without implementing teleconsult infrastructure in v1.

Phase 3 work must not be mixed into Phase 2D.

## Phase 2 prescription image workflow (v1)

Clinic staff upload the actual prescription image (camera photo or screenshot) through `POST /api/v1/patients/:patientId/prescription-documents/upload` using `imageBase64`, `fileName`, and `mimeType` (`image/jpeg`, `image/png`, or `image/webp`). The backend stores the original image under `PRESCRIPTION_STORAGE_DIR` using a generated storage key, SHA-256 checksum, MIME type, and size metadata. The raw image is never exposed as a public/static file.

The upload stores the original image, creates a `MedicationDraft`, and queues the configured vision-capable AI model through BullMQ. The worker creates the draft medication candidates with confidence/source text and any clinical-review flag. Staff can edit the draft and submit it through the verification endpoint. A second AI verification pass compares the final staff-submitted list with the stored prescription image. Any omission, addition, mismatch, unreadable text, low confidence, or AI failure causes `NEEDS_CLINICAL_REVIEW` rather than silently accepting the medication list.

Version 1 intentionally excludes pharmacy integration and direct EMR API integration. EMR screenshots can be uploaded as images through the same workflow.

For development, use the local filesystem. For production, point `PRESCRIPTION_STORAGE_DIR` at a persistent mounted volume or replace the storage adapter with an encrypted object-storage implementation. Do not expose this directory through Express static middleware.

## Phase 2C
- Verified medication drafts can be finalized into active MedicationRecord entries.
- Every medication record receives an immutable MedicationHistory version 1 snapshot.
- Medication history is append-only; no route overwrites historical snapshots.
- Prescription storage uses an adapter interface; local storage is development-only and can be replaced by private object storage later.
- Pharmacy integration and direct EMR API integration are deferred from v1.

## Phase 2C implementation notes
- MedicationRecord is the current accepted medication state and is created only from a verified MedicationDraft.
- MedicationHistory stores immutable versioned snapshots; historical entries are never updated by medication finalization.
- Active medication uniqueness is scoped by patient and medication key (name + strength + route).
- Pharmacy dispensing/reconciliation is intentionally deferred beyond v1.


## Prescription AI worker

Prescription image upload and medication-list verification no longer call the vision model inside the HTTP request.

The API flow is:

1. `POST /patients/:patientId/prescription-documents/upload` stores the image and creates a `MedicationDraft` in `DRAFT` state.
2. The API enqueues `analyze-prescription-image` on the `apexcare-prescription-analysis` BullMQ queue and returns `202 Accepted` with `jobId`.
3. The worker runs vision analysis, updates the draft, and moves the prescription to `VERIFICATION_REQUIRED` or `NEEDS_CLINICAL_REVIEW`.
4. Staff submits the edited medication list. The API saves it, moves the draft to `VERIFYING`, queues `verify-prescription-medications`, and returns `202 Accepted`.
5. The worker performs the second image-vs-list safety check and moves the draft to `VERIFIED` or back to `VERIFICATION_REQUIRED` with clinical review required.

Run the API and worker as separate processes. The existing `npm run worker` process now starts the prescription AI worker along with the existing reminder, operational, and care-plan workers.

## Phase 2D — Clinical review and 24-hour escalation

Phase 2D adds the clinical-review control layer around prescription/medication verification.

- AI discrepancy, terminal AI analysis failure, terminal AI verification failure, and staff-rejected medication drafts can open a `ClinicalReviewCase` for the assigned clinic clinician.
- The assigned clinic clinician receives a 24-hour review window and can approve, reject, or explicitly escalate the case to ApexCare.
- A BullMQ operational worker escalates unresolved clinic reviews to `APEXCARE_REVIEW` after the 24-hour SLA.
- ApexCare doctors can see the ApexCare review queue, atomically claim a case, and approve/reject it.
- ApexCare approval is explicitly marked `protocolSafe: true` and only verifies the medication draft; it does not prescribe, discontinue, or silently modify the clinic prescription.
- Every state transition is recorded in append-only `ClinicalReviewEvent` records.
- Medication finalization is blocked while an unresolved clinical-review case exists, even if a draft has otherwise been marked verified.
- ApexCare doctors can access the original prescription image only through an active ApexCare clinical-review case; the image is never public.
- Specialist referral, general-medicine doubt clearance, specialist scheduling, and teleconsultation remain Phase 3 scope and are not part of Phase 2D.

## Phase 2E idempotency contract

Care-plan generation is asynchronous and idempotent. One `DietitianAssessment` belongs to one `ApexCareEnrollment`, enforced by a sparse unique index. `ApexCareEnrollment.carePlanGenerationStatus` tracks NOT_STARTED/QUEUED/PROCESSING/COMPLETED/FAILED. BullMQ job IDs are scoped to enrollment + assessment + attempt, and jobs carry clinic and ApexCare tenant IDs plus patient, clinician, enrollment and assessment IDs. The worker revalidates coordinator contact, enrollment, patient assignment and assessment ownership before generation. Generation failures are thrown so BullMQ can retry; terminal failures are persisted as FAILED. Existing clinician-review drafts are reused and duplicate-key races converge on the existing draft.
