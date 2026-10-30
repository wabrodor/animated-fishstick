'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Clock3,
} from 'lucide-react';

import { Gate, RoleGate, Shell } from '@/components/Shell';
import { patientById } from '@/lib/api';
import type { Patient } from '@/types/api';

export default function PatientRegisteredPage() {
  const router = useRouter();

  const { patientId } = useParams<{
    patientId: string;
  }>();

  const [patient, setPatient] =
    useState<Patient | null>(null);

  const [error, setError] =
    useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const result =
          await patientById(patientId);

        if (active) {
          setPatient(result);
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : 'Unable to load patient.',
          );
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [patientId]);

  return (
    <Gate>
      <RoleGate allowed={['CLINICIAN']}>
        <Shell
          title="Patient registered"
          subtitle="Clinical handoff completed"
        >
          <Link
            href="/patients"
            className="muted back-link"
          >
            <ArrowLeft size={14} />
            My patients
          </Link>

          {!patient ? (
            <div className="card glass handoff-loading">
              {error ||
                'Preparing handoff confirmation…'}
            </div>
          ) : (
            <section className="handoff-page">

              {/* ==================================================
                  SUCCESS HEADER
                  ================================================== */}

              <div className="card glass handoff-hero">

                <div className="handoff-success-icon">
                  <CheckCircle2 size={28} />
                </div>

                <div>
                  <div className="eyebrow">
                    Registration complete
                  </div>

                  <h2>
                    Patient successfully registered
                  </h2>

                  <p>
                    The hypertension diagnosis has
                    been recorded and the patient is
                    now awaiting ApexCare enrolment.
                  </p>
                </div>

              </div>

              {/* ==================================================
                  PATIENT CARD
                  ================================================== */}

              <div className="card glass">

                <div className="section-head">
                  <div>
                    <div className="eyebrow">
                      Patient
                    </div>

                    <h2>
                      {patient.name.first}{' '}
                      {patient.name.last}
                    </h2>
                  </div>

                  <span className="badge blue">
                    HYPERTENSION
                  </span>
                </div>

                <div className="handoff-patient-grid">

                  <div>
                    <span>
                      Medical record number
                    </span>

                    <strong>
                      {patient.medicalRecordNumber ||
                        '—'}
                    </strong>
                  </div>

                  <div>
                    <span>
                      Enrollment status
                    </span>

                    <strong>
                      {patient.enrollmentStatus ||
                        'NOT_ENROLLED'}
                    </strong>
                  </div>

                </div>

              </div>

              {/* ==================================================
                  NEXT STEP
                  ================================================== */}

              <div className="card glass handoff-next">

                <div className="handoff-next-icon">
                  <ClipboardList size={20} />
                </div>

                <div>
                  <div className="eyebrow">
                    Next step
                  </div>

                  <h2>
                    Coordinator enrolment
                  </h2>

                  <p>
                    The patient is now in the clinic's ApexCare referral queue. The care coordinator can open the referral, capture the required enrolment information, prescription and vitals, and complete enrolment.
                  </p>
                </div>

                <div className="handoff-state">
                  <Clock3 size={14} />
                  Awaiting enrolment
                </div>

              </div>

              {/* ==================================================
                  RESPONSIBILITY HANDOFF
                  ================================================== */}

              <div className="card glass">

                <div className="section-head">
                  <div>
                    <div className="eyebrow">
                      Workflow
                    </div>

                    <h2>
                      Your part is complete
                    </h2>
                  </div>
                </div>

                <div className="handoff-flow">

                  <div className="handoff-step done">
                    <div className="handoff-step-number">
                      <CheckCircle2 size={14} />
                    </div>

                    <div>
                      <b>
                        Clinician registration
                      </b>

                      <span>
                        Patient created and diagnosis
                        confirmed.
                      </span>
                    </div>
                  </div>

                  <div className="handoff-line" />

                  <div className="handoff-step pending">
                    <div className="handoff-step-number">
                      2
                    </div>

                    <div>
                      <b>
                        Coordinator enrolment
                      </b>

                      <span>
                        Consent and ApexCare enrolment.
                      </span>
                    </div>
                  </div>

                </div>

              </div>

              {/* ==================================================
                  ACTIONS
                  ================================================== */}

              <div className="handoff-actions">

                <Link
                  href="/patients"
                  className="primary"
                >
                  Back to my patients
                </Link>

                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    router.refresh()
                  }
                >
                  Stay here
                </button>

              </div>

            </section>
          )}
        </Shell>
      </RoleGate>
    </Gate>
  );
}