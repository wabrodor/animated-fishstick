# Phase 3B.1 — Care-plan activation & patient delivery intent
- Reuses Patient.preferredLanguage and preferredContactChannel.
- Adds minimal PatientCommunication with deterministic idempotencyKey.
- Emits CARE_PLAN_ACTIVATED through existing outbox when an execution is ensured.
- Generates a concise patient-facing message in the preferred language when AI is enabled.
- Falls back to a deterministic message when AI is unavailable.
- Adds a clinic endpoint to inspect communication records.
- No new scheduler or clinical decision engine.
- WhatsApp provider integration remains a separate adapter.
