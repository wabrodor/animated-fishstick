'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  ShieldCheck,
  Camera,
  RefreshCw,
  FileCheck2,
  HeartPulse,
} from 'lucide-react';

import { enrolPatient, recordCoordinatorVitals, updateEnrollmentProfile, uploadPrescription } from '@/lib/api';

type PatientForEnrollment = {
  _id: string;

  medicalRecordNumber?: string;

  name: {
    first: string;
    last?: string;
  };

  phone?: string;

  enrollmentStatus?: string;

  assignedClinicianId?: string;

  conditions?: Array<{
    code: string;
    status?: string;
    diagnosedAt?: string;
  }>;
};

export function CoordinatorEnrollment({
  patient,
  onCompleted,
}: {
  patient: PatientForEnrollment;
  onCompleted?: (result: {
    patientId: string;
    enrollmentStatus:
      | 'CARE_PLAN_REVIEW'
      | 'ENROLLED';
    assignedClinicianId?: string;
  }) => void;
}) {
  const [consentGiven, setConsentGiven] =
    useState(false);
  const [phone, setPhone] = useState(patient.phone || '');
  const [whatsapp, setWhatsapp] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState('en');
  const [preferredContactChannel, setPreferredContactChannel] = useState<'PHONE' | 'SMS' | 'WHATSAPP' | 'APP'>('PHONE');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(Boolean(patient.phone));

  const [consentMethod, setConsentMethod] =
    useState<
      'VERBAL' |
      'WRITTEN' |
      'DIGITAL'
    >('VERBAL');

  const [saving, setSaving] =
    useState(false);

  const [message, setMessage] =
    useState('');

  const [completed, setCompleted] =
    useState(false);

  const [prescriptionUploaded, setPrescriptionUploaded] =
    useState(false);

  const [uploadingPrescription, setUploadingPrescription] =
    useState(false);

  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [pulse, setPulse] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [savingVitals, setSavingVitals] = useState(false);
  const [vitalsCaptured, setVitalsCaptured] = useState(false);

  async function saveProfile() {
    if (!phone.trim()) { setMessage('A patient phone number is required before enrolment.'); return; }
    setSavingProfile(true); setMessage('');
    try {
      await updateEnrollmentProfile(patient._id, { phone: phone.trim(), ...(whatsapp.trim() ? { whatsapp: whatsapp.trim() } : {}), preferredLanguage: preferredLanguage.trim() || 'en', preferredContactChannel });
      setProfileSaved(true);
      setMessage('Patient contact details saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save patient contact details.'); }
    finally { setSavingProfile(false); }
  }

  async function handlePrescription(file: File) {
    if (!file) return;
    setUploadingPrescription(true);
    setMessage('');
    try {
      await uploadPrescription(patient._id, file);
      setPrescriptionUploaded(true);
      setMessage('Prescription captured. You can now complete enrolment.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to capture prescription.');
      setPrescriptionUploaded(false);
    } finally {
      setUploadingPrescription(false);
    }
  }

  async function handleVitals() {
    const systolicValue = Number(systolic);
    const diastolicValue = Number(diastolic);
    const pulseValue = pulse ? Number(pulse) : undefined;
    const weightValue = weightKg ? Number(weightKg) : undefined;

    if (!systolic || !diastolic || !Number.isFinite(systolicValue) || !Number.isFinite(diastolicValue)) {
      setMessage('Record both systolic and diastolic blood pressure before enrolment.');
      return;
    }
    if (pulse && (!Number.isFinite(pulseValue) || pulseValue < 20 || pulseValue > 250)) {
      setMessage('Enter a valid pulse between 20 and 250 bpm.');
      return;
    }
    if (weightKg && (!Number.isFinite(weightValue) || weightValue < 1 || weightValue > 500)) {
      setMessage('Enter a valid weight between 1 and 500 kg.');
      return;
    }

    setSavingVitals(true);
    setMessage('');
    try {
      await recordCoordinatorVitals(patient._id, {
        recordedAt: new Date().toISOString(),
        source: 'OPD',
        bloodPressure: { systolic: systolicValue, diastolic: diastolicValue, ...(pulseValue !== undefined ? { pulse: pulseValue } : {}) },
        ...(weightValue !== undefined ? { weightKg: weightValue } : {}),
      });
      setVitalsCaptured(true);
      setMessage('Vitals recorded. You can now complete enrolment.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to record vitals.');
      setVitalsCaptured(false);
    } finally {
      setSavingVitals(false);
    }
  }

  async function submit() {
    if (!prescriptionUploaded) {
      setMessage('Prescription capture is required before ApexCare enrolment.');
      return;
    }

    if (!vitalsCaptured) {
      setMessage("Vitals are required before ApexCare enrolment. Record the patient's blood pressure first.");
      return;
    }

    if (!consentGiven) {
      setMessage(
        'Patient consent is required before enrolment.',
      );
      return;
    }

    setSaving(true);
    setMessage('');

    try {
      const result =
        await enrolPatient(
          patient._id,
          {
            communicationConsent: true,

            consentMethod,

            // Keep this version explicit and auditable.
            consentVersion: '1.0',
          },
        );

      setCompleted(true);

      onCompleted?.(result);

      setMessage(
        'Patient successfully enrolled.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to enrol patient.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (completed) {
    return (
      <section className="card glass coordinator-enrolment">

        <div className="enrol-success">

          <div className="enrol-success-icon">
            <CheckCircle2 size={25} />
          </div>

          <div>
            <div className="eyebrow">
              Enrolment complete
            </div>

            <h2>
              {patient.name.first}{' '}
              {patient.name.last}
            </h2>

            <p>
              The patient is now enrolled in
              ApexCare.
            </p>
          </div>

        </div>

        <div className="enrol-next-state">

          <ClipboardCheck size={17} />

          <div>
            <b>
              Care-plan preparation started
            </b>

            <span>
              The assigned clinician will review
              the AI-generated care-plan draft
              when it is ready.
            </span>
          </div>

        </div>

        {message && (
          <div
            className="alert"
            style={{
              marginTop: 14,
            }}
          >
            {message}
          </div>
        )}

      </section>
    );
  }

  return (
    <section className="card glass coordinator-enrolment">

      {/* ======================================================
          HEADER
          ====================================================== */}

      <div className="section-head">

        <div>
          <div className="eyebrow">
            ApexCare enrolment
          </div>

          <h2>
            Complete patient enrolment
          </h2>

          <p className="muted">
            Confirm programme consent before the
            patient enters active ApexCare care.
          </p>
        </div>

        <div className="enrol-icon">
          <ClipboardCheck size={20} />
        </div>

      </div>

      {/* ======================================================
          PATIENT INFORMATION
          ====================================================== */}

      <div className="enrol-patient-card">

        <div className="enrol-avatar">
          {patient.name.first[0]}
          {patient.name.last?.[0]}
        </div>

        <div>

          <b>
            {patient.name.first}{' '}
            {patient.name.last}
          </b>

          <span>
            {patient.medicalRecordNumber ||
              'No MRN'}
          </span>

          <span>
            Hypertension ·{' '}
            {patient.enrollmentStatus ||
              'NOT_ENROLLED'}
          </span>

        </div>

      </div>

      {/* ======================================================
          PRIVACY
          ====================================================== */}

      <div className="privacy-note">
        <ShieldCheck size={15} />

        <span>
          Only collect and record the consent required
          for ApexCare enrolment. Clinical decisions remain
          with the assigned clinician.
        </span>
      </div>

      <div className="enrol-section">
        <div className="section-head">
          <div>
            <div className="eyebrow">Step 0 · Contact details</div>
            <h3>Confirm patient contact details</h3>
            <p className="muted">The phone number is required by the enrollment backend and will also be used for coordinator follow-up.</p>
          </div>
        </div>
        <div className="enrolment-form-grid">
          <label>Phone number<input value={phone} onChange={(e) => { setPhone(e.target.value); setProfileSaved(false); }} placeholder="+91…" /></label>
          <label>WhatsApp (optional)<input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="+91…" /></label>
          
            <label className="field">
  <span>Preferred language</span>

  <select
    value={preferredLanguage}
    onChange={(event) =>
      setPreferredLanguage(event.target.value)
    }
  >
    <option value="en">English</option>
    <option value="ml">Malayalam</option>
  </select>
</label>
          <label>Preferred channel<select value={preferredContactChannel} onChange={(e) => setPreferredContactChannel(e.target.value as typeof preferredContactChannel)}><option value="PHONE">Phone</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option><option value="APP">Patient app</option></select></label>
        </div>
        <button type="button" className="secondary full-action" onClick={() => void saveProfile()} disabled={savingProfile || !phone.trim()}>{savingProfile ? 'Saving…' : profileSaved ? 'Contact details saved' : 'Save contact details'}</button>
      </div>

      {/* ======================================================
          PRESCRIPTION — REQUIRED BEFORE ENROLMENT
          ====================================================== */}
      <div className="enrol-section prescription-enrolment-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Required clinical document</div>
            <h3>Doctor's prescription</h3>
            <p className="muted">Capture the prescription here during patient enrolment. Do not move this into the Medicines menu.</p>
          </div>
          {prescriptionUploaded ? <FileCheck2 size={20} /> : <Camera size={20} />}
        </div>
        <label className="camera-capture glass-subtle">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            disabled={uploadingPrescription}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handlePrescription(file);
              event.currentTarget.value = '';
            }}
          />
          <span className="camera-capture-icon">{uploadingPrescription ? <RefreshCw className="spin" size={20} /> : <Camera size={20} />}</span>
          <span>
            <b>{uploadingPrescription ? 'Uploading prescription…' : prescriptionUploaded ? 'Prescription captured — retake if needed' : 'Take prescription photo'}</b>
            <small>Use the camera on mobile or choose a JPG, PNG or WebP image.</small>
          </span>
        </label>
        {prescriptionUploaded && <div className="inline-feedback page-enter"><FileCheck2 size={15} /> Prescription captured successfully.</div>}
      </div>

      {/* ======================================================
          VITALS — REQUIRED BEFORE ENROLMENT
          ====================================================== */}
      <div className="enrol-section enrollment-vitals-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Required onboarding information</div>
            <h3>Record vitals</h3>
            <p className="muted">Capture the patient's current clinic vitals before ApexCare enrolment can be submitted.</p>
          </div>
          {vitalsCaptured ? <CheckCircle2 size={20} /> : <HeartPulse size={20} />}
        </div>
        <div className="vitals-required-grid">
          <label><span>Systolic BP <b>*</b></span><input type="number" min="40" max="300" inputMode="numeric" value={systolic} onChange={(e) => { setSystolic(e.target.value); setVitalsCaptured(false); }} placeholder="120" /></label>
          <label><span>Diastolic BP <b>*</b></span><input type="number" min="20" max="200" inputMode="numeric" value={diastolic} onChange={(e) => { setDiastolic(e.target.value); setVitalsCaptured(false); }} placeholder="80" /></label>
          <label><span>Pulse <small>(optional)</small></span><input type="number" min="20" max="250" inputMode="numeric" value={pulse} onChange={(e) => { setPulse(e.target.value); setVitalsCaptured(false); }} placeholder="72" /></label>
          <label><span>Weight kg <small>(optional)</small></span><input type="number" min="1" max="500" step="0.1" inputMode="decimal" value={weightKg} onChange={(e) => { setWeightKg(e.target.value); setVitalsCaptured(false); }} placeholder="70.0" /></label>
        </div>
        <div className="enrol-vitals-actions">
          <button type="button" className="secondary" disabled={savingVitals} onClick={() => void handleVitals()}>
            {savingVitals ? 'Saving vitals…' : vitalsCaptured ? 'Vitals recorded' : 'Save vitals'}
          </button>
          {vitalsCaptured && <span className="inline-feedback"><CheckCircle2 size={15} /> Vitals captured successfully.</span>}
        </div>
      </div>

      {/* ======================================================
          CONSENT
          ====================================================== */}

      <div className="enrol-section">

        <div className="eyebrow">
          Patient consent
        </div>

        <label className="consent-option">

          <input
            type="checkbox"
            checked={consentGiven}
            onChange={(event) =>
              setConsentGiven(
                event.target.checked,
              )
            }
          />

          <span>
            The patient has agreed to participate
            in the ApexCare chronic-care programme.
          </span>

        </label>

      </div>

      {/* ======================================================
          CONSENT METHOD
          ====================================================== */}

      <div className="enrol-section">

        <div className="eyebrow">
          Consent method
        </div>

        <div className="choice-row">

          {(
            [
              'VERBAL',
              'WRITTEN',
              'DIGITAL',
            ] as const
          ).map((method) => (
            <button
              key={method}
              type="button"
              className={
                consentMethod === method
                  ? 'choice selected'
                  : 'choice'
              }
              onClick={() =>
                setConsentMethod(method)
              }
            >
              {method}
            </button>
          ))}

        </div>

      </div>

      {/* ======================================================
          ERROR
          ====================================================== */}

      {message && (
        <div
          className="alert"
          style={{
            marginTop: 16,
          }}
        >
          {message}
        </div>
      )}

      {/* ======================================================
          ACTION
          ====================================================== */}

      <div className="enrol-actions">

        <button
          type="button"
          className="primary"
          disabled={
            saving ||
            !consentGiven ||
            !prescriptionUploaded ||
            !vitalsCaptured ||
            uploadingPrescription ||
            savingVitals
          }
          onClick={submit}
        >
          <CheckCircle2 size={15} />

          {saving
            ? 'Enrolling…'
            : 'Confirm consent & enrol'}
        </button>

      </div>

    </section>
  );
}