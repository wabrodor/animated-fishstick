"use client";

import { CoordinatorEnrollment } from "@/components/CordinatorEnrollment";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Activity,
  AlertTriangle,
  FileText,
  Pill,
  RefreshCw,
  CalendarDays,
  MessageSquareText,
  Check,
  ClipboardList,
  Clock3,
  HeartPulse,
  ShieldCheck,
  Stethoscope,
  Users,
  X,
} from "lucide-react";

import { Shell, Gate } from "@/components/Shell";

import {
  approveDraft,
  updateDraftPlan,
  clinicalSignals,
  diagnoses,
  drafts,
  labDocuments,
  labInterpretation,
  labResults,
  uploadLabDocument,
  retryLabDocument,
  fetchLabDocumentFile,
  medications,
  carePlanExecution,
  carePlanCommunications,
  reviewClinicalSignal,
  reviewLabInterpretation,
  opd,
  patientById,
  patientCases,
  patientVitals,
  patientApexGeneralHistory,
  prescriptionDocuments,
  medicationDrafts,
  transitionMilestone,
  plans,
  progressSummary,
  rejectDraft,
  uploadPrescription,
  submitMedicationDraft,
  finalizeMedicationDraft,
} from "@/lib/api";

import type {
  CarePlan,
  Diagnosis,
  OpdVisit,
  Patient,
  ServiceCase,
  VitalRecord,
  ClinicalSignal,
  LabDocument,
  LabInterpretation,
  LabResult,
  Medication,
  CarePlanExecution,
  PrescriptionDocument,
  MedicationDraft,
  ApexCareGeneralHistoryPatientSnapshot,
  ApexCareGeneralHistoryAnswer,
} from "@/types/api";

import { ClinicalProgressSummary } from '@/components/ClinicalProgressSummary';
import { APEX_GENERAL_HISTORY_SECTIONS } from '@/lib/apex-general-history';

type Section = "overview" | "care" | "vitals" | "labs" | "medications" | "opd" | "services";
type DraftPlanView = { summary: string; goals: Array<{ title: string; target?: string; rationale?: string }>; tasks: Array<{ type: string; title: string; dueDay: number; rationale?: string }>; clinicalInterventionNeeded: boolean; confidence: number; safetyNotes: string[] };

function Badge({ s }: { s?: string }) {
  const tone =
    s === "ACTIVE" || s === "COMPLETED" || s === "CONFIRMED"
      ? "success"
      : s === "OVERDUE" || s === "CANCELLED"
        ? "danger"
        : s === "REQUESTED" || s === "PENDING" || s === "SCHEDULED"
          ? "warn"
          : "blue";

  return (
    <span className={`badge ${tone}`}>
      {(s || "UNKNOWN").replaceAll("_", " ")}
    </span>
  );
}

function readRole() {
  try {
    const raw = localStorage.getItem("apexcare_user");

    if (!raw) {
      return {
        clinician: false,
        coordinator: false,
        admin: false,
      };
    }

    const user = JSON.parse(raw) as {
      roles?: string[];
    };

    return {
      clinician: user.roles?.includes("CLINICIAN") === true,
      coordinator: user.roles?.includes("CLINIC_COORDINATOR") === true,
      admin: user.roles?.includes("CLINIC_ADMIN") === true,
    };
  } catch {
    return {
      clinician: false,
      coordinator: false,
      admin: false,
    };
  }
}

function initials(patient: Patient) {
  return `${patient.name.first[0] || ""}${patient.name.last?.[0] || ""}`;
}

export default function PatientPage() {
  const { patientId } = useParams<{
    patientId: string;
  }>();

  const [patient, setPatient] = useState<Patient | null>(null);

  const [diagnosesList, setDiagnosesList] = useState<Diagnosis[]>([]);

  const [carePlans, setCarePlans] = useState<CarePlan[]>([]);

  const [vitals, setVitals] = useState<VitalRecord[]>([]);

  const [opdVisits, setOpdVisits] = useState<OpdVisit[]>([]);

  const [services, setServices] = useState<ServiceCase[]>([]);
  const [labDocs, setLabDocs] = useState<LabDocument[]>([]);
  const [labData, setLabData] = useState<Record<string, { results: LabResult[]; interpretation?: LabInterpretation }>>({});
  const [labUploadBusy, setLabUploadBusy] = useState(false);
  const [signals, setSignals] = useState<ClinicalSignal[]>([]);
  const [medicationList, setMedicationList] = useState<Medication[]>([]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionDocument[]>([]);
  const [prescriptionDrafts, setPrescriptionDrafts] = useState<Record<string, MedicationDraft[]>>({});
  const [execution, setExecution] = useState<CarePlanExecution | null>(null);
  const [communications, setCommunications] = useState<Array<Record<string, unknown>>>([]);
  const [clinicalActionBusy, setClinicalActionBusy] = useState<string | null>(null);
  const [prescriptionUploadBusy, setPrescriptionUploadBusy] = useState(false);
  const [prescriptionMessage, setPrescriptionMessage] = useState<string | null>(null);
  const [generalHistory, setGeneralHistory] = useState<ApexCareGeneralHistoryPatientSnapshot | null>(null);
  const [generalHistoryLoading, setGeneralHistoryLoading] = useState(false);
  const [generalHistoryError, setGeneralHistoryError] = useState<string | null>(null);

  const [careDrafts, setCareDrafts] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, DraftPlanView>>({});

  const [clinicalSummary, setClinicalSummary] = useState<Record<
    string,
    unknown
  > | null>(null);

  // ==========================================================
  // PAGE STATE
  // ==========================================================

  const [section, setSection] = useState<Section>("overview");

  const [message, setMessage] = useState("");

  const [busy, setBusy] = useState(false);

  const roles = readRole();

  const clinician = roles.clinician;
  const coordinator = roles.coordinator;
  const admin = roles.admin;

  // ==========================================================
  // NEW: Patient lifecycle state
  //
  // NOT_ENROLLED     -> coordinator must complete consent first
  // CARE_PLAN_REVIEW -> enrolment is complete; AI care-plan
  //                     preparation/review is in progress
  // ACTIVE_CARE      -> normal Patient 360 + Visit Assist
  // ==========================================================
  const isCoordinatorEnrollmentPending =
    coordinator && patient?.enrollmentStatus === 'NOT_ENROLLED';

  const isCarePlanReview =
    coordinator && patient?.enrollmentStatus === 'CARE_PLAN_REVIEW';

  // ==========================================================
  // LOAD PATIENT 360
  //
  // Patient identity is critical.
  // Everything else is secondary and must not break the page.
  // ==========================================================



  async function refresh() {
    const patientRecord = await patientById(patientId);

    setPatient(patientRecord);

    const [
      diagnosisResult,
      carePlanResult,
      vitalsResult,
      opdResult,
      serviceResult,
    ] = await Promise.allSettled([
      diagnoses(patientId),
      plans(patientId),
      patientVitals(patientId),
      opd(patientId),
      patientCases(patientId),
    ]);

    if (diagnosisResult.status === "fulfilled") {
      setDiagnosesList(diagnosisResult.value);
    }

    if (carePlanResult.status === "fulfilled") {
      setCarePlans(carePlanResult.value);
    }

    if (vitalsResult.status === "fulfilled") {
      setVitals(vitalsResult.value);
    }

    if (opdResult.status === "fulfilled") {
      setOpdVisits(opdResult.value);
    }

    if (serviceResult.status === "fulfilled") {
      setServices(serviceResult.value);
    }

    const [medsResult, prescriptionResult] = await Promise.allSettled([
      medications(patientId),
      prescriptionDocuments(patientId),
    ]);

    if (medsResult.status === "fulfilled") setMedicationList(medsResult.value);
    if (prescriptionResult.status === "fulfilled") {
      setPrescriptions(prescriptionResult.value);
      const draftEntries = await Promise.all(prescriptionResult.value.slice(0, 6).map(async (document) => {
        try { return [document._id, await medicationDrafts(patientId, document._id)] as const; } catch { return [document._id, []] as const; }
      }));
      setPrescriptionDrafts(Object.fromEntries(draftEntries));
    }

    if (coordinator) {
      const communicationResult = await Promise.allSettled([carePlanCommunications(patientId)]);
      if (communicationResult[0].status === "fulfilled") setCommunications(communicationResult[0].value);
    }

    if (clinician || coordinator) {
      setGeneralHistoryLoading(true);
      setGeneralHistoryError(null);
      const [labsResult, signalResult, historyResult] = await Promise.allSettled([
        labDocuments(patientId),
        clinician ? clinicalSignals(patientId) : Promise.resolve([]),
        clinician ? patientApexGeneralHistory(patientId) : Promise.resolve(null),
      ]);
      if (historyResult.status === 'fulfilled') {
        setGeneralHistory(historyResult.value);
      } else {
        setGeneralHistory(null);
        setGeneralHistoryError(historyResult.reason instanceof Error ? historyResult.reason.message : 'Unable to load coordinator-recorded history.');
      }
      setGeneralHistoryLoading(false);
      if (labsResult.status === "fulfilled") {
        setLabDocs(labsResult.value);
        const entries = clinician ? await Promise.all(labsResult.value.slice(0, 8).map(async (doc) => {
          try {
            const [resultSet, interpretation] = await Promise.allSettled([labResults(patientId, doc._id), labInterpretation(patientId, doc._id)]);
            return [doc._id, { results: resultSet.status === "fulfilled" ? resultSet.value.results : [], interpretation: interpretation.status === "fulfilled" ? interpretation.value : undefined }] as const;
          } catch { return [doc._id, { results: [] }] as const; }
        })) : [];
        setLabData(Object.fromEntries(entries));
      }
      if (signalResult.status === "fulfilled") setSignals(signalResult.value);
    }

    // --------------------------------------------------------
    // Clinician-only clinical intelligence
    // --------------------------------------------------------

    if (clinician) {
      const [draftsResult, summaryResult] = await Promise.allSettled([
        drafts(patientId),
        progressSummary(patientId),
      ]);

      if (draftsResult.status === "fulfilled") {
        setCareDrafts(draftsResult.value);
      }

      if (summaryResult.status === "fulfilled") {
        setClinicalSummary(summaryResult.value);
      }
    }

    if (carePlanResult.status === "fulfilled" && carePlanResult.value[0]) {
      const executionResult = await Promise.allSettled([carePlanExecution(patientId, carePlanResult.value[0]._id)]);
      if (executionResult[0].status === "fulfilled") setExecution(executionResult[0].value);
    }
  }


  useEffect(() => {
    refresh().catch((error) => {
      setMessage(
        error instanceof Error ? error.message : "Unable to load patient.",
      );
    });
  }, [patientId, clinician]);

  async function handleMilestone(milestoneId: string, action: 'COMPLETE' | 'SKIP') {
    if (!activePlan) return;
    setClinicalActionBusy(`milestone:${milestoneId}`);
    try {
      const result = await transitionMilestone(patientId, activePlan._id, milestoneId, action);
      if (execution) {
        setExecution({ ...execution, milestones: execution.milestones.map((item) => String(item._id) === milestoneId ? { ...item, ...(result as { milestone?: Record<string, unknown> }).milestone } : item) });
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to update the care milestone.'); } finally { setClinicalActionBusy(null); }
  }

  async function handleLabReview(documentId: string, decision: 'APPROVED' | 'MODIFIED' | 'REJECTED') {
    setClinicalActionBusy(`lab:${documentId}`);
    setMessage("");
    try {
      const updated = await reviewLabInterpretation(patientId, documentId, { decision });
      setLabData((current) => ({ ...current, [documentId]: { ...current[documentId], interpretation: updated } }));
      setMessage(decision === 'REJECTED' ? 'Lab interpretation rejected.' : 'Lab interpretation reviewed successfully.');
      if (decision !== 'REJECTED') setSignals(await clinicalSignals(patientId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to review the lab interpretation.');
    } finally {
      setClinicalActionBusy(null);
    }
  }

  async function handleLabUpload(file?: File) {
    if (!file) return;
    if (file.type !== 'application/pdf') { setMessage('Choose a PDF lab report.'); return; }
    setLabUploadBusy(true);
    try {
      await uploadLabDocument(patientId, file);
      setMessage('Lab report uploaded. OCR and extraction are queued.');
      await refreshClinicalData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to upload the lab report.');
    } finally { setLabUploadBusy(false); }
  }

  async function handleLabRetry(documentId: string, stage: 'OCR' | 'AI_EXTRACTION') {
    setClinicalActionBusy(`lab-retry:${documentId}`);
    try {
      await retryLabDocument(patientId, documentId, stage);
      setMessage(`${stage === 'OCR' ? 'OCR' : 'AI extraction'} retry queued.`);
      await refreshClinicalData();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to retry document processing.'); }
    finally { setClinicalActionBusy(null); }
  }

  async function handleOpenLabFile(documentId: string) {
    try {
      const blob = await fetchLabDocumentFile(patientId, documentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to open the lab report.'); }
  }

  async function handleSignalReview(signalId: string, decision: 'ACTION_REQUIRED' | 'REVIEWED' | 'DISMISSED') {
    setClinicalActionBusy(`signal:${signalId}`);
    setMessage("");
    try {
      const updated = await reviewClinicalSignal(signalId, { decision });
      setSignals((current) => current.map((signal) => signal._id === signalId ? updated : signal));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to review the clinical signal.');
    } finally {
      setClinicalActionBusy(null);
    }
  }

  async function handlePrescriptionCapture(file: File) {
    if (!file.type.startsWith('image/')) { setPrescriptionMessage('Please choose a prescription image.'); return; }
    setPrescriptionUploadBusy(true);
    setPrescriptionMessage(null);
    try {
      await uploadPrescription(patientId, file);
      setPrescriptionMessage('Prescription captured. Analysis is running in the background.');
      await refresh();
    } catch (error) {
      setPrescriptionMessage(error instanceof Error ? error.message : 'Unable to capture the prescription.');
    } finally { setPrescriptionUploadBusy(false); }
  }

  async function handleDraftSubmit(documentId: string, draft: MedicationDraft) {
    setClinicalActionBusy(`draft:${draft._id}`);
    setPrescriptionMessage(null);
    try {
      await submitMedicationDraft(patientId, documentId, draft._id, draft.medications || []);
      setPrescriptionMessage('Medication list submitted for verification.');
      await refresh();
    } catch (error) { setPrescriptionMessage(error instanceof Error ? error.message : 'Unable to submit medication list.'); }
    finally { setClinicalActionBusy(null); }
  }

  async function handleDraftFinalize(documentId: string, draft: MedicationDraft) {
    setClinicalActionBusy(`finalize:${draft._id}`);
    setPrescriptionMessage(null);
    try {
      await finalizeMedicationDraft(patientId, documentId, draft._id, 'Finalized after verification.');
      setPrescriptionMessage('Verified medicines added to the patient record.');
      await refresh();
    } catch (error) { setPrescriptionMessage(error instanceof Error ? error.message : 'Unable to finalize medicines.'); }
    finally { setClinicalActionBusy(null); }
  }

  async function refreshClinicalData() {
    setClinicalActionBusy('refresh');
    try { await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to refresh clinical data.'); } finally { setClinicalActionBusy(null); }
  }

  // ==========================================================
  // DERIVED METRICS
  // ==========================================================

  const latestVital = vitals[0];

  const latestBP = latestVital?.bloodPressure;

  const activePlan =
    carePlans.find((plan) => plan.status === "ACTIVE") || carePlans[0];

  const latestOPD = opdVisits[0];

  const diagnosis = diagnosesList.find(
    (item) => item.condition === "HYPERTENSION",
  );

  const carePlanDays = useMemo(() => {
    if (!activePlan?.startDate) {
      return null;
    }

    const start = new Date(activePlan.startDate).getTime();

    const now = Date.now();

    const days = Math.floor((now - start) / (1000 * 60 * 60 * 24)) + 1;

    return Math.max(1, days);
  }, [activePlan]);


async function handleEnrollmentCompleted() {
  await refresh();
}

  // ==========================================================
  // CLINICIAN: AI CARE PLAN
  // ==========================================================

  async function approve(draftId: string) {
    setBusy(true);
    setMessage("");

    try {
      await approveDraft(patientId, draftId);

      await refresh();

      setMessage("Care plan approved and activated.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to approve draft.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reject(draftId: string) {
    setBusy(true);
    setMessage("");

    try {
      await rejectDraft(patientId, draftId);

      await refresh();

      setMessage("Draft rejected.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to reject draft.",
      );
    } finally {
      setBusy(false);
    }
  }

  function startDraftEdit(draftId: string, plan: DraftPlanView) {
    setDraftEdits((current) => ({ ...current, [draftId]: JSON.parse(JSON.stringify(plan)) as DraftPlanView }));
    setEditingDraftId(draftId);
  }

  async function saveDraftEdit(draftId: string) {
    const plan = draftEdits[draftId];
    if (!plan) return;
    setBusy(true); setMessage("");
    try {
      const updated = await updateDraftPlan(patientId, draftId, plan as unknown as Record<string, unknown>);
      setCareDrafts((current) => current.map((draft) => String(draft._id) === draftId ? updated : draft));
      setEditingDraftId(null);
      setMessage("Clinician edits saved to the draft. Review and approve it when ready.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save draft edits.");
    } finally { setBusy(false); }
  }

  // ==========================================================
  // LOADING
  // ==========================================================

  return (
    <Gate>
      <Shell title="Patient 360" subtitle="Longitudinal patient workspace">
        {/* ====================================================
            BACK LINK
            ==================================================== */}

        <Link href="/patients" className="muted back-link">
          <ArrowLeft size={14} />
          Patients
        </Link>

        {!patient ? (
          <div
            className="card glass"
            style={{
              marginTop: 12,
            }}
          >
            Loading patient workspace…
          </div>
        ) : (
          <>
            {/* =================================================
                NEW: COORDINATOR ENROLMENT STATE

                A newly diagnosed patient should not enter the
                normal Patient 360 workspace until ApexCare
                enrolment is completed.
                ================================================= */}
            {isCoordinatorEnrollmentPending ? (
              <>
                <section className="patient360-header glass" style={{ marginTop: 12 }}>
                  <div className="patient360-identity">
                    <div className="patient360-avatar">
                      {initials(patient)}
                    </div>

                    <div>
                      <div className="eyebrow">New diagnosis</div>
                      <h2>
                        {patient.name.first} {patient.name.last}
                      </h2>
                      <p>
                        {patient.medicalRecordNumber || "No MRN"}
                        {" · "}
                        Hypertension · Awaiting enrolment
                      </p>
                    </div>
                  </div>

                  <div className="patient360-status">
                    <Badge s="NOT_ENROLLED" />
                    {diagnosis && <Badge s={diagnosis.status} />}
                  </div>
                </section>

                <CoordinatorEnrollment
                  patient={patient}
                  onCompleted={handleEnrollmentCompleted}
                />
              </>
            ) : isCarePlanReview ? (
              <>
                {/* =================================================
                    NEW: POST-ENROLMENT / CARE-PLAN REVIEW STATE
                    Coordinator sees progress, not clinical content.
                    ================================================= */}
                <section className="patient360-header glass" style={{ marginTop: 12 }}>
                  <div className="patient360-identity">
                    <div className="patient360-avatar">
                      {initials(patient)}
                    </div>

                    <div>
                      <div className="eyebrow">ApexCare enrolment complete</div>
                      <h2>
                        {patient.name.first} {patient.name.last}
                      </h2>
                      <p>
                        {patient.medicalRecordNumber || "No MRN"}
                        {" · "}
                        Care-plan preparation is in progress
                      </p>
                    </div>
                  </div>

                  <div className="patient360-status">
                    <Badge s="CARE_PLAN_REVIEW" />
                  </div>
                </section>

                <section className="card glass" style={{ marginTop: 14 }}>
                  <div className="handoff-next">
                    <div className="handoff-next-icon">
                      <Clock3 size={20} />
                    </div>

                    <div>
                      <div className="eyebrow">Next step</div>
                      <h2>Awaiting clinician care-plan review</h2>
                      <p>
                        The patient is enrolled successfully. The AI care-plan
                        draft is being prepared for the assigned clinician.
                      </p>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <>
                {/* =================================================
                    EXISTING ACTIVE-CARE PATIENT 360
                    ================================================= */}

                {/* =================================================
                    PATIENT HEADER
                    ================================================= */}

            <section className="patient360-header glass">
              <div className="patient360-identity">
                <div className="patient360-avatar">{initials(patient)}</div>

                <div>
                  <div className="eyebrow">Hypertension program</div>

                  <h2>
                    {patient.name.first} {patient.name.last}
                  </h2>

                  <p>
                    {patient.medicalRecordNumber || "No MRN"}
                    {" · "}
                    {patient.phone || "No phone"}
                  </p>
                </div>
              </div>

              <div className="patient360-status">
                <Badge s={patient.enrollmentStatus} />

                {diagnosis && <Badge s={diagnosis.status} />}

                {clinician && patient.enrollmentStatus === "CARE_PLAN_REVIEW" && (
                  <span className="badge warn">Care plan review pending</span>
                )}
              </div>
            </section>

            {/* =================================================
                QUICK METRIC STRIP
                ================================================= */}

            <div className="patient360-metrics">
              <div className="metric-card glass">
                <span>Latest BP</span>

                <strong>
                  {latestBP
                    ? `${latestBP.systolic}/${latestBP.diastolic}`
                    : "—"}
                </strong>

                <small>
                  {latestVital
                    ? new Date(latestVital.recordedAt).toLocaleDateString()
                    : "No reading"}
                </small>
              </div>

              <div className="metric-card glass">
                <span>Last OPD</span>

                <strong>
                  {latestOPD
                    ? new Date(latestOPD.visitAt).toLocaleDateString()
                    : "—"}
                </strong>

                <small>{latestOPD?.reason || "No visit"}</small>
              </div>

              <div className="metric-card glass">
                <span>Care plan</span>

                <strong>{activePlan?.status || "Not active"}</strong>

                <small>
                  {carePlanDays ? `Day ${carePlanDays}` : "Not started"}
                </small>
              </div>

              <div className="metric-card glass">
                <span>ApexCare</span>

                <strong>{services.length}</strong>

                <small>Service requests</small>
              </div>
            </div>

            {/* =================================================
                GLOBAL MESSAGE
                ================================================= */}

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

            {/* =================================================
                ROLE CONTEXT
                ================================================= */}

            {coordinator && (
              <div className="patient-role-note">
                <Users size={15} />

                <span>
                  Coordinator workspace — focus on patient follow-up, visit
                  completion and care coordination.
                </span>
              </div>
            )}

            {clinician && (
              <div className="patient-role-note clinician-note">
                <Stethoscope size={15} />

                <span>
                  Clinical workspace — review patient progress, care plans and
                  clinician-only AI information.
                </span>
              </div>
            )}

            {coordinator && patient?.enrollmentStatus === "ACTIVE_CARE" && (
              <section className="card glass visit-assist-card" style={{ marginTop: 14 }}>
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Coordinator reviews</div>
                    <h2>Pending patient reviews</h2>
                    <p className="muted">Use the dedicated review queue to call the patient, send an automated reminder, record unanswered contacts and complete the operational review.</p>
                  </div>
                  <Link className="primary" href="/reviews">Open review queue <ArrowUpRight size={14} /></Link>
                </div>
                <div className="privacy-note"><ShieldCheck size={14} /><span>Clinical interpretation and treatment decisions remain with the assigned clinician.</span></div>
              </section>
            )}

            {/* =================================================
                NAVIGATION
                ================================================= */}

            <div className="patient360-nav glass">
              {[
                ["overview", "Overview"],
                ["care", "Care plan"],
                ["vitals", "Vitals"],
                ...((clinician || coordinator) ? [["labs", "Labs"]] : []),
                ["medications", "Medicines"],
                ["opd", "OPD"],
                ["services", "ApexCare"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={
                    section === key ? "patient360-tab active" : "patient360-tab"
                  }
                  onClick={() => setSection(key as Section)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* =================================================
                OVERVIEW
                ================================================= */}

            {section === "overview" && (
              <div className="patient360-grid">
                {/* MAIN COLUMN */}

                <div className="patient360-main">
                  {clinician && clinicalSummary && (
                    <section className="card glass">
                      {/* <div className="section-head">
                        <div>
                          <div className="eyebrow">Clinical view</div>

                          <h2>Progress summary</h2>
                        </div>

                        <Stethoscope size={19} color="#1677ff" />
                      </div> */}

                      <ClinicalProgressSummary
  summary={clinicalSummary}
/>
                    </section>
                  )}

                  {clinician && (
                    <section className="card glass patient360-general-history">
                      <div className="section-head patient360-general-history-heading">
                        <div>
                          <div className="eyebrow">ApexCare coordinator intake</div>
                          <h2>General medical history</h2>
                          <span className="muted">Patient-reported information · read-only clinical reference</span>
                        </div>
                        <div className="patient360-general-history-badge"><FileText size={17} /><span>{generalHistory ? 'RECORDED' : 'HISTORY'}</span></div>
                      </div>

                      {generalHistoryLoading ? (
                        <div className="empty-state compact"><span className="loading-orb" /><b>Loading recorded history…</b></div>
                      ) : generalHistoryError ? (
                        <div className="alert alert-error" role="alert"><span>{generalHistoryError}</span><button type="button" className="secondary" onClick={() => void refreshClinicalData()}>Retry</button></div>
                      ) : !generalHistory ? (
                        <div className="empty-state compact"><FileText size={20} /><b>No coordinator-recorded history yet</b><span>Once the ApexCare coordinator records the baseline, it will appear here. Drafts are not shown in the clinical snapshot.</span></div>
                      ) : (
                        <>
                          <div className="patient360-general-history-meta">
                            <span><b>Recorded:</b> {generalHistory.recordedAt ? new Date(generalHistory.recordedAt).toLocaleString() : 'Date not available'}</span>
                            <span><b>Collected by:</b> {generalHistory.collectedByName || 'ApexCare coordinator'}</span>
                          </div>
                          <div className="patient360-general-history-sections">
                            {APEX_GENERAL_HISTORY_SECTIONS.map((historySection) => {
                              const answers = generalHistory.answers.filter((answer: ApexCareGeneralHistoryAnswer) => answer.section === historySection.id);
                              if (!answers.length) return null;
                              return (
                                <section className="patient360-general-history-section" key={historySection.id}>
                                  <h3>{historySection.title}</h3>
                                  {answers.map((answer) => (
                                    <article className="patient360-general-history-answer" key={answer.questionId}>
                                      <div><b>{answer.question}</b><span className={`badge ${answer.answer === 'YES' ? 'warn' : answer.answer === 'NO' ? 'success' : 'blue'}`}>{answer.answer.replaceAll('_', ' ')}</span></div>
                                      {answer.details && <p>{answer.details}</p>}
                                    </article>
                                  ))}
                                </section>
                              );
                            })}
                          </div>
                          {generalHistory.notes && <div className="patient360-general-history-notes"><b>Coordinator notes</b><p>{generalHistory.notes}</p></div>}
                          <p className="patient360-general-history-disclaimer">This is a record of information reported to the ApexCare coordinator. It is not a diagnosis, clinical verification or treatment recommendation.</p>
                        </>
                      )}
                    </section>
                  )}

                  <section className="card glass">
                    <div className="section-head">
                      <div>
                        <div className="eyebrow">Longitudinal record</div>

                        <h2>Recent activity</h2>
                      </div>

                      <span className="muted">Latest events</span>
                    </div>

                    <div className="timeline">
                      {latestOPD && (
                        <div className="timeline-item">
                          <div className="timeline-icon">
                            <CalendarDays size={16} />
                          </div>

                          <div>
                            <b>OPD visit</b>

                            <p>{latestOPD.reason}</p>

                            <span>
                              {new Date(latestOPD.visitAt).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      )}

                      {latestVital && (
                        <div className="timeline-item">
                          <div className="timeline-icon">
                            <HeartPulse size={16} />
                          </div>

                          <div>
                            <b>Vital recorded</b>

                            <p>
                              {latestBP
                                ? `${latestBP.systolic}/${latestBP.diastolic} mmHg`
                                : "Vital record"}
                            </p>

                            <span>
                              {new Date(
                                latestVital.recordedAt,
                              ).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      )}

                      {diagnosis && (
                        <div className="timeline-item">
                          <div className="timeline-icon">
                            <Activity size={16} />
                          </div>

                          <div>
                            <b>Hypertension diagnosis</b>

                            <p>{diagnosis.status}</p>

                            <span>
                              {new Date(
                                diagnosis.diagnosedAt,
                              ).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                {/* SIDE COLUMN */}

                <aside className="patient360-side">
                  <section className="card glass">
                    <div className="section-head">
                      <h2>Care status</h2>
                    </div>

                    <div className="status-line">
                      <span>Enrollment</span>

                      <Badge s={patient.enrollmentStatus} />
                    </div>

                    <div className="status-line">
                      <span>Care plan</span>

                      <Badge s={activePlan?.status} />
                    </div>

                    <div className="status-line">
                      <span>ApexCare cases</span>

                      <strong>{services.length}</strong>
                    </div>
                  </section>

                  {coordinator && <section className="card glass">
                    <div className="section-head"><div><div className="eyebrow">Patient contact</div><h2>Message history</h2></div><MessageSquareText size={18} /></div>
                    {!communications.length && <div className="empty-state compact"><b>No automated messages yet</b><span>Messages queued from coordinator follow-up will appear here.</span></div>}
                    {communications.slice(0, 5).map((item, index) => <div className="mini-item" key={String(item._id || index)}><b>{String(item.purpose || 'Communication').replaceAll('_', ' ')}</b><span>{String(item.status || 'UNKNOWN')} · {item.createdAt ? new Date(String(item.createdAt)).toLocaleString() : 'Recent'}</span></div>)}
                  </section>}

                  <section className="card glass">
                    <div className="section-head">
                      <h2>Latest vitals</h2>

                      <HeartPulse size={18} color="#1677ff" />
                    </div>

                    <div className="big-vital">
                      <strong>
                        {latestBP
                          ? `${latestBP.systolic}/${latestBP.diastolic}`
                          : "—"}
                      </strong>

                      <span>mmHg</span>
                    </div>

                    <p className="muted">
                      {latestVital
                        ? new Date(latestVital.recordedAt).toLocaleString()
                        : "No recent vitals"}
                    </p>
                  </section>
                </aside>
              </div>
            )}

            {/* =================================================
                CARE PLAN
                ================================================= */}

            {section === "care" && (
              <div className="patient360-grid">
                <section className="card glass">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">90-day program</div>

                      <h2>Active care plan</h2>
                    </div>

                    <Badge s={activePlan?.status} />
                  </div>

                  {activePlan ? (
                    <>
                      <div className="care-plan-strip">
                        <div>
                          <span>Start</span>

                          <strong>
                            {new Date(
                              activePlan.startDate,
                            ).toLocaleDateString()}
                          </strong>
                        </div>

                        <div>
                          <span>Day</span>

                          <strong>
                            {carePlanDays || "—"}
                            /90
                          </strong>
                        </div>

                        <div>
                          <span>Goals</span>

                          <strong>{activePlan.goals.length}</strong>
                        </div>
                      </div>

                      <div className="care-goals">
                        {activePlan.goals.map((goal, index) => (
                          <div className="goal" key={index}>
                            <div className="goal-dot">
                              <Check size={13} />
                            </div>

                            <div>
                              <b>{goal.title}</b>

                              <p>{goal.target}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">No active care plan.</div>
                  )}
                </section>

                {execution && (
                  <section className="card glass">
                    <div className="section-head"><div><div className="eyebrow">90-day execution</div><h2>Care milestones</h2></div><Badge s={String(execution.execution.status || 'ACTIVE')} /></div>
                    <div className="milestone-list">
                      {execution.milestones.map((milestone) => (
                        <div className="milestone" key={String(milestone._id)}>
                          <div className={`milestone-dot ${String(milestone.status) === 'COMPLETED' ? 'done' : ''}`}>{String(milestone.status) === 'COMPLETED' ? <Check size={13}/> : <Clock3 size={13}/>}</div>
                          <div style={{ flex: 1 }}><b>{String(milestone.title || milestone.name || milestone.key || 'Milestone')}</b><span>{String(milestone.status || 'PENDING')}</span></div>
                          {String(milestone.status) !== 'COMPLETED' && String(milestone.status) !== 'SKIPPED' && (
                            <button className="secondary" disabled={clinicalActionBusy === `milestone:${String(milestone._id)}`} onClick={() => handleMilestone(String(milestone._id), 'COMPLETE')}>Complete</button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {clinician && (
                  <section className="card glass">
                    <div className="section-head">
                      <div>
                        <div className="eyebrow">ApexCare handoff</div>

                        <h2>Care-plan drafts</h2>
                      </div>

                      <ShieldCheck size={18} />
                    </div>

                    {!careDrafts.length && (
                      <div className="empty-state">
                        <b>No ApexCare care-plan draft is available yet.</b>
                        <span>Care-plan generation is owned by ApexCare after enrolment. The clinician reviews a generated draft when it reaches this workspace.</span>
                      </div>
                    )}

                    {careDrafts.slice(0, 3).map((draft, index) => {
                      const id = String(draft._id || index);

                      const status = String(draft.status || "UNKNOWN");

                      const plan = draft.plan as DraftPlanView | undefined;
                      const editing = editingDraftId === id;
                      const viewPlan = editing ? draftEdits[id] || plan : plan;

                      return (
                        <div className="draft-card" key={id}>
                          <div className="section-head">
                            <div><b>Hypertension care plan · 90 days</b><div className="muted">Version {Number(draft.version || 1)} · {String(draft.source || 'RULES')} draft · clinician approval required</div></div>

                            <Badge s={status} />
                          </div>

                          {Boolean(draft.inputSnapshot) && <div className="mini-item"><b>Source data & verification</b><span>Review all values against the record. Unknown values remain unknown. {(() => { const completeness = (draft.inputSnapshot as { dataCompleteness?: { score?: number; missing?: string[] } }).dataCompleteness; return `Completeness ${completeness?.score ?? '—'}% · Missing: ${(completeness?.missing || ['not provided']).join(', ')}`; })()}</span></div>}

                          <label className="draft-plan-field"><b>Plan summary</b>{editing ? <textarea value={viewPlan?.summary || ''} onChange={(event) => setDraftEdits((current) => ({ ...current, [id]: { ...viewPlan!, summary: event.target.value } }))} rows={3} /> : <p>{viewPlan?.summary || 'Summary not provided.'}</p>}</label>

                          <div className="draft-plan-section"><b>Care goals</b>{viewPlan?.goals?.map((goal, goalIndex) => <div className="draft-plan-row" key={`${goal.title}-${goalIndex}`}>{editing ? <><input aria-label="Goal title" value={goal.title} onChange={(event) => setDraftEdits((current) => { const next = { ...viewPlan! }; next.goals = [...next.goals]; next.goals[goalIndex] = { ...goal, title: event.target.value }; return { ...current, [id]: next }; })} /><input aria-label="Goal target" value={goal.target || ''} placeholder="Target / schedule" onChange={(event) => setDraftEdits((current) => { const next = { ...viewPlan! }; next.goals = [...next.goals]; next.goals[goalIndex] = { ...goal, target: event.target.value }; return { ...current, [id]: next }; })} /></> : <><strong>{goal.title}</strong><span>{goal.target || 'Target to be confirmed'}</span>{goal.rationale && <small>{goal.rationale}</small>}</>}</div>)}</div>

                          <div className="draft-plan-section"><b>90-day tasks</b>{viewPlan?.tasks?.map((task, taskIndex) => <div className="draft-plan-row" key={`${task.title}-${taskIndex}`}>{editing ? <><input aria-label="Task title" value={task.title} onChange={(event) => setDraftEdits((current) => { const next = { ...viewPlan! }; next.tasks = [...next.tasks]; next.tasks[taskIndex] = { ...task, title: event.target.value }; return { ...current, [id]: next }; })} /><label>Day <input aria-label="Due day" type="number" min="0" max="90" value={task.dueDay} onChange={(event) => setDraftEdits((current) => { const next = { ...viewPlan! }; next.tasks = [...next.tasks]; next.tasks[taskIndex] = { ...task, dueDay: Number(event.target.value) }; return { ...current, [id]: next }; })} /></label></> : <><strong>Day {task.dueDay} · {task.title}</strong><span>{task.type.replaceAll('_', ' ')}</span>{task.rationale && <small>{task.rationale}</small>}</>}</div>)}</div>

                          <div className="mini-item"><b>Clinical review flag</b><span>{viewPlan?.clinicalInterventionNeeded ? 'Clinician attention requested' : 'No additional flag recorded'} · AI confidence {Math.round((viewPlan?.confidence || 0) * 100)}% (not a clinical certainty score)</span></div>
                          <div className="mini-item"><b>Safety and verification notes</b><span>{viewPlan?.safetyNotes?.join(' · ') || 'No safety notes provided.'}</span></div>

                          {(status === "GENERATED" || status === "CLINICIAN_REVIEW") && (
                            <div className="toolbar">
                              {editing ? <><button className="secondary" disabled={busy} onClick={() => void saveDraftEdit(id)}>Save edits</button><button className="secondary" disabled={busy} onClick={() => setEditingDraftId(null)}>Cancel</button></> : <button className="secondary" disabled={busy} onClick={() => plan && startDraftEdit(id, plan)}>Edit draft</button>}
                              <button
                                className="secondary"
                                disabled={busy || editing}
                                onClick={() => reject(id)}
                              >
                                <X size={14} />
                                Reject
                              </button>

                              <button
                                className="primary"
                                disabled={busy || editing}
                                onClick={() => approve(id)}
                              >
                                <Check size={14} />
                                Approve & activate
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </section>
                )}
              </div>
            )}

            {/* =================================================
                VITALS
                ================================================= */}

            {section === "vitals" && (
              <div className="patient360-grid">
                <section className="card glass">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Longitudinal monitoring</div>

                      <h2>Blood pressure</h2>
                    </div>

                    <HeartPulse size={19} color="#1677ff" />
                  </div>

                  <div className="chart">
                    {vitals
                      .slice(0, 10)
                      .reverse()
                      .map((item) => {
                        const value = item.bloodPressure?.systolic || 0;

                        const height = Math.max(
                          15,
                          Math.min(100, ((value - 90) / 80) * 100),
                        );

                        return (
                          <div
                            className="barwrap"
                            key={item._id}
                            title={`${value} mmHg`}
                          >
                            <div
                              className="bar"
                              style={{
                                height: `${height}%`,
                              }}
                            />
                          </div>
                        );
                      })}
                  </div>
                </section>

                <section className="card glass">
                  <div className="section-head">
                    <h2>Recent readings</h2>

                    <span className="muted">{vitals.length}</span>
                  </div>

                  {vitals.slice(0, 8).map((item) => (
                    <div className="list" key={item._id}>
                      <div className="section-head">
                        <b>
                          {item.bloodPressure
                            ? `${item.bloodPressure.systolic}/${item.bloodPressure.diastolic} mmHg`
                            : "No BP"}
                        </b>

                        <span className="muted">
                          {new Date(item.recordedAt).toLocaleDateString()}
                        </span>
                      </div>

                      <p>
                        {item.source || "Recorded"}

                        {item.weightKg ? ` · ${item.weightKg} kg` : ""}
                      </p>
                    </div>
                  ))}

                  {!vitals.length && (
                    <div className="empty-state">No vitals recorded.</div>
                  )}
                </section>
              </div>
            )}

            {/* =================================================
                LABS + CLINICAL SIGNALS
                ================================================= */}

            {(clinician || coordinator) && section === "labs" && (
              <div className="patient360-grid">
                <section className="card glass">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Structured laboratory record</div>
                      <h2>Lab reports</h2>
                    </div>
                    <button className="icon-button" onClick={refreshClinicalData} disabled={clinicalActionBusy === 'refresh'} title="Refresh">
                      <RefreshCw size={16} className={clinicalActionBusy === 'refresh' ? 'spin' : ''} />
                    </button>
                  </div>

                  {coordinator && <label className="secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: labUploadBusy ? 'wait' : 'pointer' }}>
                    {labUploadBusy ? 'Uploading…' : 'Upload lab PDF'}
                    <input type="file" accept="application/pdf,.pdf" hidden disabled={labUploadBusy} onChange={(event) => { void handleLabUpload(event.target.files?.[0]); event.currentTarget.value = ''; }} />
                  </label>}

                  {!labDocs.length && <div className="empty-state">No lab reports available yet.</div>}
                  {labDocs.map((doc) => {
                    const data = labData[doc._id];
                    const interpretation = data?.interpretation;
                    return (
                      <div className="lab-report-card" key={doc._id}>
                        <div className="section-head">
                          <div className="person">
                            <div className="service-icon"><FileText size={17} /></div>
                            <div><b>{doc.fileName}</b><span>{doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleString() : 'Uploaded report'}</span></div>
                          </div>
                          <Badge s={interpretation?.clinicianReviewStatus || doc.interpretationStatus || doc.structuringStatus} />
                        </div>
                        <button className="secondary" type="button" onClick={() => void handleOpenLabFile(doc._id)}>Open original PDF</button>

                        <p className="muted">Processing: {doc.processingStage || doc.extractionStatus || 'Queued'} · Attempts: {doc.processingAttempts ?? 0}</p>
                        <p className="muted">OCR source: {doc.ocrEngine ? `${doc.ocrEngine}${doc.ocrEngineVersion ? ` ${doc.ocrEngineVersion}` : ''}` : 'Not available'}{doc.ocrWarningCode || doc.extractionWarningCode ? ` · ${doc.ocrWarningCode || doc.extractionWarningCode}` : ''}</p>
                        {doc.extractionStatus === 'FAILED' && <button className="secondary" disabled={clinicalActionBusy === `lab-retry:${doc._id}`} onClick={() => void handleLabRetry(doc._id, 'OCR')}>Retry OCR</button>}
                        {doc.extractionStatus === 'COMPLETED' && doc.structuringStatus === 'FAILED' && <button className="secondary" disabled={clinicalActionBusy === `lab-retry:${doc._id}`} onClick={() => void handleLabRetry(doc._id, 'AI_EXTRACTION')}>Retry AI extraction</button>}

                        {!!data?.results?.length && (
                          <div className="lab-result-grid">
                            {data.results.map((result) => (
                              <div className={`lab-result ${result.abnormalFlag !== 'NORMAL' ? 'abnormal' : ''}`} key={result._id}>
                                <div><span>{result.testName}</span><b>{result.valueText}{result.unit ? ` ${result.unit}` : ''}</b></div>
                                <small>{result.abnormalFlag !== 'NORMAL' ? result.abnormalFlag : result.referenceRangeText || 'Within reference range'} · {result.reviewStatus || 'UNVERIFIED'}{result.sourcePage ? ` · page ${result.sourcePage}` : ''}</small>
                                {result.sourceText && <small className="muted">Source: {result.sourceText}</small>}
                              </div>
                            ))}
                          </div>
                        )}

                        {interpretation && (
                          <div className={`interpretation ${interpretation.urgentReview ? 'urgent' : ''}`}>
                            <div className="interpretation-title"><AlertTriangle size={15} /> <b>AI clinical interpretation</b><span className="muted">{Math.round((interpretation.confidence || 0) * 100)}% confidence</span></div>
                            <p>{interpretation.clinicianReviewStatus === 'PENDING' ? interpretation.clinicianSummary : (interpretation.clinicianApprovedSummary || interpretation.clinicianSummary)}</p>
                            {interpretation.suggestedDiscussionPoints?.length ? <ul>{interpretation.suggestedDiscussionPoints.map((point) => <li key={point}>{point}</li>)}</ul> : null}
                            {clinician && interpretation.clinicianReviewStatus === 'PENDING' && (
                              <div className="toolbar">
                                <button className="secondary" disabled={clinicalActionBusy === `lab:${doc._id}`} onClick={() => handleLabReview(doc._id, 'REJECTED')}>Reject</button>
                                <button className="primary" disabled={clinicalActionBusy === `lab:${doc._id}`} onClick={() => handleLabReview(doc._id, 'APPROVED')}><Check size={14}/> Approve & create signals</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>

                <section className="card glass">
                  <div className="section-head"><div><div className="eyebrow">Clinician attention</div><h2>Clinical signals</h2></div><Badge s={signals.length ? 'OPEN' : 'COMPLETED'} /></div>
                  {!signals.length && <div className="empty-state">No clinical signals for this patient.</div>}
                  {signals.map((signal) => (
                    <div className="signal-card" key={signal._id}>
                      <div className="section-head"><div><b>{signal.kind.replaceAll('_', ' ')}</b><p>{signal.summary}</p></div><span className={`priority ${signal.priority.toLowerCase()}`}>{signal.priority}</span></div>
                      <div className="toolbar">
                        <Badge s={signal.status} />
                        {clinician && signal.status === 'OPEN' && <>
                          <button className="secondary" disabled={clinicalActionBusy === `signal:${signal._id}`} onClick={() => handleSignalReview(signal._id, 'DISMISSED')}>Dismiss</button>
                          <button className="primary" disabled={clinicalActionBusy === `signal:${signal._id}`} onClick={() => handleSignalReview(signal._id, 'ACTION_REQUIRED')}>Action required</button>
                        </>}
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            )}

            {/* =================================================
                MEDICATIONS
                ================================================= */}

            {section === "medications" && (
              <section className="card glass">
                <div className="section-head"><div><div className="eyebrow">Prescription workflow output</div><h2>Current medicines</h2></div><Pill size={18} color="#1677ff" /></div>
                <p className="muted">Only verified medication records are shown here. Prescription analysis and clinical review remain governed by the backend workflow.</p>
                {!medicationList.length && <div className="empty-state">No active medication records yet.</div>}
                <div className="medication-grid">
                  {medicationList.map((medication) => (
                    <div className="medication-card" key={medication._id}>
                      <div className="medication-icon"><Pill size={17}/></div>
                      <div><b>{medication.name}</b><span>{[medication.strength, medication.dose].filter(Boolean).join(' · ') || 'Dose not recorded'}</span><small>{medication.frequency || 'Frequency not recorded'}{medication.route ? ` · ${medication.route}` : ''}</small>{medication.instructions && <p>{medication.instructions}</p>}</div>
                      <Badge s={medication.status} />
                    </div>
                  ))}
                </div>

                {coordinator && (
                  <>
                    <div className="section-head" style={{ marginTop: 24 }}><div><div className="eyebrow">Prescription capture</div><h2>Capture a new prescription</h2><span className="muted">Clinic coordinator captures the source prescription; analysis happens in the background.</span></div><FileText size={18} /></div>
                    <label className="camera-capture glass-subtle">
                      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handlePrescriptionCapture(file); event.currentTarget.value = ''; }} disabled={prescriptionUploadBusy} />
                      <span className="camera-capture-icon">{prescriptionUploadBusy ? <RefreshCw className="spin" size={20}/> : <FileText size={20}/>}</span>
                      <span><b>{prescriptionUploadBusy ? 'Capturing prescription…' : 'Take prescription photo'}</b><small>Clear, well-lit image · JPG, PNG or WebP</small></span>
                    </label>
                    {prescriptionMessage && <div className="inline-feedback page-enter">{prescriptionMessage}</div>}
                  </>
                )}
                {!prescriptions.length && <div className="empty-state">No prescription documents captured yet.</div>}
                {prescriptions.map((document) => (
                  <div className="prescription-row" key={document._id}>
                    <div className="service-icon"><FileText size={16}/></div>
                    <div><b>{document.fileName || 'Prescription document'}</b><span>{document.capturedAt ? new Date(document.capturedAt).toLocaleString() : 'Captured prescription'}</span><small>{document.analysisStatus || document.status || 'PENDING'}{document.clinicalReviewReason ? ` · ${document.clinicalReviewReason}` : ''}</small></div>
                    <Badge s={document.analysisStatus || document.status} />
                    {prescriptionDrafts[document._id]?.length ? <div className="draft-summary">{prescriptionDrafts[document._id].slice(0,2).map((draft) => <div className="draft-action" key={draft._id}><span>{draft.medications?.length || 0} medication candidate{draft.medications?.length === 1 ? '' : 's'} · {draft.status || 'PENDING'}</span>{draft.status === 'VERIFICATION_REQUIRED' && coordinator && <button className="secondary" disabled={clinicalActionBusy === `draft:${draft._id}`} onClick={() => void handleDraftSubmit(document._id, draft)}>{clinicalActionBusy === `draft:${draft._id}` ? 'Submitting…' : 'Submit for verification'}</button>}{draft.status === 'VERIFIED' && (coordinator || clinician) && <button className="primary" disabled={clinicalActionBusy === `finalize:${draft._id}`} onClick={() => void handleDraftFinalize(document._id, draft)}>{clinicalActionBusy === `finalize:${draft._id}` ? 'Finalizing…' : 'Finalize medicines'}</button>}</div>)}</div> : null}
                  </div>
                ))}
              </section>
            )}

            {/* =================================================
                OPD
                ================================================= */}

            {section === "opd" && (
              <section className="card glass">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Clinical timeline</div>

                    <h2>OPD visits</h2>
                  </div>

                  <Stethoscope size={18} color="#1677ff" />
                </div>

                <div className="timeline">
                  {opdVisits.map((visit) => (
                    <div className="timeline-item" key={visit._id}>
                      <div className="timeline-icon">
                        <CalendarDays size={15} />
                      </div>

                      <div>
                        <div className="section-head">
                          <b>{visit.reason || "OPD follow-up"}</b>

                          <span className="muted">
                            {new Date(visit.visitAt).toLocaleString()}
                          </span>
                        </div>

                        <p>{visit.notes || "No visit notes recorded."}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {!opdVisits.length && (
                  <div className="empty-state">No OPD visits recorded.</div>
                )}
              </section>
            )}

            {/* =================================================
                APEXCARE SERVICES
                ================================================= */}

            {section === "services" && (
              <section className="card glass">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Care coordination</div>

                    <h2>ApexCare services</h2>
                  </div>

                  <span className="muted">Clinician initiated</span>
                </div>

                {services.map((item) => (
                  <div className="service-row" key={item._id}>
                    <div className="service-icon">
                      {item.service === "DIETITIAN" ? "D" : "E"}
                    </div>

                    <div>
                      <b>
                        {item.service === "DIETITIAN"
                          ? "Dietitian"
                          : "Endocrinology"}
                      </b>

                      <p>{item.reason}</p>
                    </div>

                    <Badge s={item.status} />
                  </div>
                ))}

                {!services.length && (
                  <div className="empty-state">
                    No ApexCare service requests yet.
                  </div>
                )}
              </section>
            )}

              </>
            )}
          </>
        )}
      </Shell>
    </Gate>
  );
}
