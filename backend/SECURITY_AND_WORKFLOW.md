# ApexCare Hypertension Workflow: Security and Verification Plan

## Canonical end-to-end path

1. Clinic admin creates clinician/coordinator accounts.
2. Assigned clinician records a confirmed hypertension diagnosis.
3. Coordinator/nurse obtains ApexCare programme consent.
4. Coordinator enrols the patient into ApexCare.
5. Enrolment queues asynchronous AI/rules draft generation.
6. Patient enters `CARE_PLAN_REVIEW` while the assigned clinician waits for the draft.
7. Assigned clinician reviews, edits externally if needed, approves or rejects the draft.
8. Approval creates the active 90-day care plan and care tasks.
9. Coordinator records vitals and completes operational tasks.
10. Assigned clinician records/reviews OPD visits and progress.
11. Clinic requests ApexCare dietitian/endocrinology service cases when needed.

## Authorization matrix

| Action | Clinic Admin | Clinician | Coordinator/Nurse | ApexCare roles |
|---|---:|---:|---:|---:|
| Create clinic clinician/coordinator | Yes | No | No | No |
| Diagnose hypertension | No | Yes | No | No |
| Enrol patient / record programme consent | No | No | Yes | No |
| Generate/review AI draft | No | Assigned only | No | No |
| Approve care plan | No | Assigned only | No | No |
| Record OPD | No | Assigned only | No | No |
| Record vitals | Yes | Assigned only | Yes | No |
| Complete operational care task | Yes | Assigned only | Yes | No |
| Request ApexCare service | Yes | Yes | Yes | No |
| Assign ApexCare provider | No | No | No | ApexCare coordinator |

## Security checks before production

- [ ] Run `npm ci`, `npm run typecheck`, and `npm run build` in a network environment with the declared dependencies available.
- [ ] Run dependency audit and remediate high/critical findings.
- [ ] Verify MongoDB/Redis are private and TLS-protected in production.
- [ ] Move secrets to a secret manager.
- [ ] Restrict CORS to deployed web origins.
- [ ] Configure `TRUST_PROXY` only for real reverse proxies.
- [ ] Add immutable clinical audit events for diagnosis, consent, AI draft review, approval, rejection and care-plan adjustment.
- [ ] Review AI vendor data-processing terms before enabling external AI.
- [ ] Verify backup/restore and incident-response procedures.

## Required negative tests

- Clinic A cannot access Clinic B data.
- Coordinator cannot diagnose hypertension.
- Coordinator cannot approve an AI care plan.
- Clinician cannot approve another clinician's patient's care plan.
- Clinician cannot read another clinician's patient clinical records.
- A patient cannot be enrolled without a confirmed clinician diagnosis.
- A patient cannot be enrolled without programme consent.
- AI cannot create an active care plan directly.
- AI cannot generate medication/dose changes.
- Clinic cannot create ApexCare dietitian/specialist accounts.
- ApexCare providers cannot access unassigned service cases.
- Invalid IDs return 400.
- Suspended users/organizations cannot access the API.

## Phase 2D clinical review boundary

Prescription/medication AI exceptions are handled through a dedicated `ClinicalReviewCase` rather than allowing staff or AI to bypass clinical review.

1. AI discrepancy or terminal AI failure opens a case for the assigned clinic clinician.
2. Clinic clinician has 24 hours to approve, reject, or escalate to ApexCare.
3. BullMQ escalates an unresolved case to `APEXCARE_REVIEW` after the SLA expires.
4. ApexCare doctor must claim the case before acting.
5. ApexCare approval is protocol-safe verification of the medication draft only; it cannot change the clinic prescription.
6. Medication finalization remains blocked until the clinical-review case is resolved.
7. Every transition is recorded in immutable `ClinicalReviewEvent` records.
