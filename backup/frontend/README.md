# ApexCare Clinic Portal

Next.js clinic portal for the ApexCare hypertension workflow.

## Current scope

The portal is now wired to the live Express API used by the current backend workflow:

- Login + authenticated `/me` session
- Temporary-password enforcement UI
- Live patient list
- Live coordinator care queue
- Live ApexCare service-request queue
- Patient longitudinal workspace
- Diagnoses
- Active care plan
- AI care-plan draft generation/review/approve/reject for clinicians
- BP/vitals history
- OPD history
- ApexCare service cases
- Clinician progress summary

The frontend mirrors backend authorization for UX, but the Express API remains the security boundary.

## Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

`.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:5000/api/v1
NEXT_PUBLIC_USE_MOCK_DATA=false
```

For UI-only development without the API:

```env
NEXT_PUBLIC_USE_MOCK_DATA=true
```

Mock mode must remain disabled for real clinical use.

## Routes

- `/clinic/login`
- `/apex/login`
- `/patient/login`
- `/dashboard`
- `/patients`
- `/patients/[patientId]`
- `/care-queue`
- `/team`
- `/account/password`

## Deferred backend hardening

The following are intentionally deferred while the clinic portal is developed:

- Express rate limiting
- MongoDB transaction/idempotency hardening
- BullMQ duplicate-job/idempotency hardening
- Durable clinical audit-event trail
- Production Redis/MongoDB network isolation

## Stage 2 integration baseline
- Backend API is the source of truth for authentication, authorization, patient access and operational queues.
- Clinic entry is `/clinic/login`; the legacy `/login` route is intentionally removed.
- Clinic dashboard, patient registry and care queue consume live `/api/v1` endpoints when `NEXT_PUBLIC_USE_MOCK_DATA=false`.
- Loading, retry and action states use dependency-free CSS motion for mobile performance.
