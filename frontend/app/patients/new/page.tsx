'use client';

import {
  FormEvent,
  useState,
  useEffect
} from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  ArrowLeft,
  CheckCircle2,
  UserPlus,
} from 'lucide-react';

import {
  Gate,
  RoleGate,
  Shell,
} from '@/components/Shell';

import { createPatient } from '@/lib/api';

export default function NewPatientPage() {
  const router = useRouter();

  // ==========================================================
  // Current clinician
  //
  // A clinician must create a patient assigned to themselves.
  // Backend independently verifies this.
  // ==========================================================

  const [clinicianId, setClinicianId] =
    useState('');

  // ==========================================================
  // Patient fields
  // ==========================================================

  const [medicalRecordNumber, setMedicalRecordNumber] =
    useState('');

  const [firstName, setFirstName] =
    useState('');

  const [lastName, setLastName] =
    useState('');

  const [ageAtRegistration, setAgeAtRegistration] = useState('');

  const [sexAtBirth, setSexAtBirth] =
    useState<
      'FEMALE' |
      'MALE' |
      'INTERSEX' |
      'NOT_RECORDED'
    >('NOT_RECORDED');



  const [preferredLanguage, setPreferredLanguage] =
    useState('en');

  const [preferredContactChannel, setPreferredContactChannel] =
    useState<
      'PHONE' |
      'SMS' |
      'WHATSAPP' |
      'APP'
    >('PHONE');

  // ==========================================================
  // Diagnosis
  //
  // Hypertension is intentionally fixed because this is the
  // current MVP workflow.
  // ==========================================================

  const [diagnosisDate, setDiagnosisDate] =
    useState(
      new Date()
        .toISOString()
        .slice(0, 10),
    );

  const [diagnosisNotes, setDiagnosisNotes] =
    useState('');

  // ==========================================================
  // Submission state
  // ==========================================================

  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState('');

  const [success, setSuccess] =
    useState(false);

  // ==========================================================
  // Load authenticated clinician ID
  // ==========================================================

  useEffect(() => {
    try {
      const raw =
        localStorage.getItem(
          'apexcare_user',
        );

      if (!raw) return;

      const user = JSON.parse(raw) as {
        id?: string;
      };

      if (user.id) {
        setClinicianId(user.id);
      }
    } catch {
      setClinicianId('');
    }
  }, []);

  // ==========================================================
  // Submit
  // ==========================================================

  async function submit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    setError('');
    setSuccess(false);

    if (!clinicianId) {
      setError(
        'Your clinician session could not be identified. Please sign in again.',
      );
      return;
    }

    if (!medicalRecordNumber.trim()) {
      setError(
        'Medical record number is required.',
      );
      return;
    }

    if (!firstName.trim()) {
      setError(
        'Patient first name is required.',
      );
      return;
    }

    if (!lastName.trim()) {
      setError(
        'Patient last name is required.',
      );
      return;
    }

    setSaving(true);

    try {
      const patient =
        await createPatient({
          medicalRecordNumber:
            medicalRecordNumber.trim(),

          name: {
            first:
              firstName.trim(),

            ...(lastName.trim()
              ? {
                  last:
                    lastName.trim(),
                }
              : {}),
          },

          ageAtRegistration: Number(ageAtRegistration),

          sexAtBirth,


          preferredLanguage:
            preferredLanguage.trim() ||
            'en',

          preferredContactChannel,

          // IMPORTANT:
          // The backend requires this to match the
          // authenticated clinician.
          assignedClinicianId:
            clinicianId,

          // This is what causes the backend to create
          // the confirmed hypertension Diagnosis record
          // in the same transaction-style workflow.
          diagnosis: {
            condition:
              'HYPERTENSION',

            ...(diagnosisDate
              ? {
                  diagnosedAt:
                    new Date(
                      diagnosisDate,
                    ).toISOString(),
                }
              : {}),

            ...(diagnosisNotes.trim()
              ? {
                  notes:
                    diagnosisNotes.trim(),
                }
              : {}),
          },
        });

      setSuccess(true);

      // Give the clinician a moment to see the
      // confirmation, then open the patient workspace.
      window.setTimeout(() => {
        router.push(
          `/patients/${patient._id}/registered`,
        );
      }, 600);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to register the patient.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Gate>
      <RoleGate allowed={['CLINICIAN']}>

        <Shell
          title="New patient"
          subtitle="Register the patient and confirm the hypertension diagnosis."
        >

          <Link
            href="/patients"
            className="muted back-link"
          >
            <ArrowLeft size={14} />
            Patients
          </Link>

          <form
            onSubmit={submit}
            className="new-patient-form"
          >

            {/* =================================================
                PATIENT IDENTITY
                ================================================= */}

            <section className="card glass">

              <div className="section-head">

                <div>
                  <div className="eyebrow">
                    Patient registration
                  </div>

                  <h2>
                    Patient details
                  </h2>

                  <p className="muted">
                    Enter only the information required
                    to safely create the first clinical record.
                  </p>
                </div>

                <UserPlus
                  size={20}
                  color="#1677ff"
                />

              </div>

              <div className="form-grid">

                <label className="field">
                  <span>
                    Medical record number
                  </span>

                  <input
                    value={
                      medicalRecordNumber
                    }
                    onChange={(event) =>
                      setMedicalRecordNumber(
                        event.target.value,
                      )
                    }
                    placeholder="e.g. APX-00129"
                    required
                  />
                </label>

                <div />

                <label className="field">
                  <span>
                    First name
                  </span>

                  <input
                    value={firstName}
                    onChange={(event) =>
                      setFirstName(
                        event.target.value,
                      )
                    }
                    placeholder="First name"
                    required
                  />
                </label>

                <label className="field">
                  <span>
                    Last name
                  </span>

                  <input
                    value={lastName}
                    onChange={(event) =>
                      setLastName(
                        event.target.value,
                      )
                    }
                    placeholder="Last name"
                  />
                </label>

                <label className="field">
                  <span>
                    Age
                  </span>

                  <input
                    type="number"
                    min="0"
                    max="130"
                    step="1"
                    required
                    value={ageAtRegistration}
                    onChange={(event) => setAgeAtRegistration(event.target.value)}
                  />
                </label>

                <label className="field">
                  <span>
                    Sex
                  </span>

                  <select
                    value={sexAtBirth}
                    onChange={(event) =>
                      setSexAtBirth(
                        event.target.value as
                          | 'FEMALE'
                          | 'MALE'
                          | 'INTERSEX'
                          | 'NOT_RECORDED',
                      )
                    }
                  >
                    <option value="NOT_RECORDED">
                      Not recorded
                    </option>

                    <option value="FEMALE">
                      Female
                    </option>

                    <option value="MALE">
                      Male
                    </option>

                    <option value="INTERSEX">
                      Intersex
                    </option>
                  </select>
                </label>
{/* 
                <label className="field">
                  <span>
                    Phone
                  </span>

                  <input
                    type="tel"
                    value={phone}
                    onChange={(event) =>
                      setPhone(
                        event.target.value,
                      )
                    }
                    placeholder="+91..."
                    required
                  />
                </label> */}

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

                <label className="field">
                  <span>
                    Preferred contact
                  </span>

                  <select
                    value={
                      preferredContactChannel
                    }
                    onChange={(event) =>
                      setPreferredContactChannel(
                        event.target.value as
                          | 'PHONE'
                          | 'SMS'
                          | 'WHATSAPP'
                          | 'APP',
                      )
                    }
                  >
                    <option value="PHONE">
                      Phone
                    </option>

                    <option value="SMS">
                      SMS
                    </option>

                    <option value="WHATSAPP">
                      WhatsApp
                    </option>

                    <option value="APP">
                      App
                    </option>
                  </select>
                </label>

              </div>

            </section>

            {/* =================================================
                DIAGNOSIS
                ================================================= */}

            <section className="card glass">

              <div className="section-head">

                <div>
                  <div className="eyebrow">
                    Clinical assessment
                  </div>

                  <h2>
                    Diagnosis
                  </h2>
                </div>

                <span className="badge blue">
                  HYPERTENSION
                </span>

              </div>

              <div className="diagnosis-fixed">

                <div className="diagnosis-check">
                  <CheckCircle2
                    size={20}
                  />
                </div>

                <div>
                  <b>
                    Hypertension
                  </b>

                  <p>
                    This is the currently enabled
                    condition in the ApexCare MVP.
                  </p>
                </div>

              </div>

              <div className="form-grid">

                <label className="field">
                  <span>
                    Diagnosis date
                  </span>

                  <input
                    type="date"
                    value={
                      diagnosisDate
                    }
                    onChange={(event) =>
                      setDiagnosisDate(
                        event.target.value,
                      )
                    }
                  />
                </label>

                <div />

                <label
                  className="field field-full"
                >
                  <span>
                    Clinical notes
                  </span>

                  <textarea
                    rows={4}
                    value={
                      diagnosisNotes
                    }
                    onChange={(event) =>
                      setDiagnosisNotes(
                        event.target.value,
                      )
                    }
                    placeholder="Optional clinical notes..."
                  />
                </label>

              </div>

            </section>

            {/* =================================================
                SUBMIT
                ================================================= */}

            {error && (
              <div className="alert">
                {error}
              </div>
            )}

            {success && (
              <div className="success-banner">
                <CheckCircle2
                  size={18}
                />

                <div>
                  <b>
                    Patient registered successfully
                  </b>

                  <span>
                    Hypertension diagnosis confirmed.
                    Opening the patient workspace…
                  </span>
                </div>
              </div>
            )}

            <div className="new-patient-actions">

              <Link
                href="/patients"
                className="secondary"
              >
                Cancel
              </Link>

              <button
                type="submit"
                className="primary"
                disabled={saving}
              >
                <CheckCircle2
                  size={15}
                />

                {saving
                  ? 'Registering…'
                  : 'Register patient'}
              </button>

            </div>

          </form>

        </Shell>

      </RoleGate>
    </Gate>
  );
}
