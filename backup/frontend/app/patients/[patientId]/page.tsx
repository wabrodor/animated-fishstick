"use client";

import { CoordinatorEnrollment } from "@/components/CordinatorEnrollment";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  Phone,
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
  clinicalSignals,
  diagnoses,
  drafts,
  labDocuments,
  labInterpretation,
  labResults,
  medications,
  carePlanExecution,
  carePlanCommunications,
  reviewClinicalSignal,
  reviewLabInterpretation,
  opd,
  patientById,
  patientCases,
  patientVitals,
  prescriptionDocuments,
  prescriptionImage,
  prescriptionOcrStatus,
  medicationDrafts,
  transitionMilestone,
  plans,
  progressSummary,
  rejectDraft,
  uploadPrescription,
  recordCoordinatorVitals,
  createOpdVisit,
  updatePatientContactProfile,
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
  PrescriptionOcrStatus,
} from "@/types/api";

import { ClinicalProgressSummary } from '@/components/ClinicalProgressSummary';

type Section = "overview" | "care" | "vitals" | "labs" | "medications" | "opd" | "services";
type DraftMedicationFields = NonNullable<MedicationDraft["medications"]>;
type DraftMedicationEditableField = "name" | "strength" | "dose" | "route" | "frequency" | "duration" | "instructions";

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
        userId: '',
        clinician: false,
        coordinator: false,
        admin: false,
      };
    }

    const user = JSON.parse(raw) as {
      id?: string;
      roles?: string[];
    };

    return {
      userId: user.id || '',
      clinician: user.roles?.includes("CLINICIAN") === true,
      coordinator: user.roles?.includes("CLINIC_COORDINATOR") === true,
      admin: user.roles?.includes("CLINIC_ADMIN") === true,
    };
  } catch {
    return {
      userId: '',
      clinician: false,
      coordinator: false,
      admin: false,
    };
  }
}

function initials(patient: Patient) {
  return `${patient.name.first[0] || ""}${patient.name.last?.[0] || ""}`;
}

function whatsappHref(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `https://wa.me/91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `https://wa.me/91${digits.slice(1)}`;
  return `https://wa.me/${digits}`;
}

export default function PatientPage() {
  const { patientId } = useParams<{
    patientId: string;
  }>();

  const [roles, setRoles] = useState({ userId: '', clinician: false, coordinator: false, admin: false });
  const [rolesLoaded, setRolesLoaded] = useState(false);
  useEffect(() => {
    setRoles(readRole());
    setRolesLoaded(true);
  }, []);
  const [patient, setPatient] = useState<Patient | null>(null);
  const loadedPatientIdRef = useRef<string | null>(null);

  const [diagnosesList, setDiagnosesList] = useState<Diagnosis[]>([]);

  const [carePlans, setCarePlans] = useState<CarePlan[]>([]);

  const [vitals, setVitals] = useState<VitalRecord[]>([]);

  const [opdVisits, setOpdVisits] = useState<OpdVisit[]>([]);

  const [services, setServices] = useState<ServiceCase[]>([]);
  const [labDocs, setLabDocs] = useState<LabDocument[]>([]);
  const [labData, setLabData] = useState<Record<string, { results: LabResult[]; interpretation?: LabInterpretation }>>({});
  const [signals, setSignals] = useState<ClinicalSignal[]>([]);
  const [medicationList, setMedicationList] = useState<Medication[]>([]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionDocument[]>([]);
  const [prescriptionDrafts, setPrescriptionDrafts] = useState<Record<string, MedicationDraft[]>>({});
  const [prescriptionImageUrls, setPrescriptionImageUrls] = useState<Record<string, string>>({});
  const [prescriptionImageBusyId, setPrescriptionImageBusyId] = useState<string | null>(null);
  const [prescriptionImageErrors, setPrescriptionImageErrors] = useState<Record<string, string>>({});
  const prescriptionObjectUrls = useRef<string[]>([]);
  useEffect(() => () => {
    prescriptionObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    prescriptionObjectUrls.current = [];
  }, []);

  useEffect(() => {
    prescriptionObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    prescriptionObjectUrls.current = [];
    setPrescriptionImageUrls({});
    setPrescriptionImageErrors({});
  }, [patientId]);
  const [editedDraftMedications, setEditedDraftMedications] = useState<Record<string, DraftMedicationFields>>({});
  const [prescriptionOcrRuntimeStatus, setPrescriptionOcrRuntimeStatus] = useState<PrescriptionOcrStatus | null>(null);
  const [execution, setExecution] = useState<CarePlanExecution | null>(null);
  const [communications, setCommunications] = useState<Array<Record<string, unknown>>>([]);
  const [clinicalActionBusy, setClinicalActionBusy] = useState<string | null>(null);
  const [prescriptionUploadBusy, setPrescriptionUploadBusy] = useState(false);
  const [prescriptionMessage, setPrescriptionMessage] = useState<string | null>(null);

  const [careDrafts, setCareDrafts] = useState<Array<Record<string, unknown>>>(
    [],
  );

  const [clinicalSummary, setClinicalSummary] = useState<Record<
    string,
    unknown
  > | null>(null);

  // ==========================================================
  // PAGE STATE
  // ==========================================================

  const [section, setSection] = useState<Section>("overview");

  const [message, setMessage] = useState("");
  const [patientLoadError, setPatientLoadError] = useState<string | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataIssues, setDataIssues] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [vitalsBusy, setVitalsBusy] = useState(false);
  const [opdForm, setOpdForm] = useState({ reason: 'Chronic care follow-up', assessment: '', planAdjustment: '', vitalsRecordId: '' });
  const [opdBusy, setOpdBusy] = useState(false);
  const [contactEditOpen, setContactEditOpen] = useState(false);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactForm, setContactForm] = useState({ phone: '', whatsapp: '', preferredLanguage: 'en', preferredContactChannel: 'PHONE' as 'PHONE' | 'SMS' | 'WHATSAPP' | 'APP' });
  const [vitalsForm, setVitalsForm] = useState({
    systolic: '', diastolic: '', pulse: '', weightKg: '', bloodSugar: '',
    bloodSugarType: 'RANDOM' as 'FASTING' | 'POST_PRANDIAL' | 'RANDOM',
    symptoms: '', notes: '', source: 'OPD' as 'OPD' | 'HOME' | 'DEVICE',
  });

  const [busy, setBusy] = useState(false);

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



  const refreshPrescriptionWorkflow = useCallback(async () => {
    const documents = await prescriptionDocuments(patientId);
    setPrescriptions(documents);
    let draftFailures = 0;
    const draftEntries = await Promise.all(documents.slice(0, 6).map(async (document) => {
      try {
        return [document._id, await medicationDrafts(patientId, document._id)] as const;
      } catch {
        draftFailures += 1;
        return [document._id, []] as const;
      }
    }));
    setPrescriptionDrafts(Object.fromEntries(draftEntries));
    return { documents, draftFailures };
  }, [patientId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setPatientLoadError(null);
    setDataIssues([]);
    if (loadedPatientIdRef.current !== patientId) {
      setPatientLoading(true);
      setPatient(null);
      setLastUpdated(null);
    }
    const issues: string[] = [];

    try {
      let patientRecord: Patient;
      try {
        patientRecord = await patientById(patientId);
        loadedPatientIdRef.current = patientId;
        setPatient(patientRecord);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unable to load patient record.';
        setPatientLoadError(detail);
        throw error;
      }

      const [diagnosisResult, carePlanResult, vitalsResult, opdResult, serviceResult] = await Promise.allSettled([
        diagnoses(patientId), plans(patientId), patientVitals(patientId), opd(patientId), patientCases(patientId),
      ]);

      if (diagnosisResult.status === 'fulfilled') setDiagnosesList(diagnosisResult.value);
      else { setDiagnosesList([]); issues.push('diagnoses'); }

      if (carePlanResult.status === 'fulfilled') setCarePlans(carePlanResult.value);
      else { setCarePlans([]); setExecution(null); issues.push('care plans'); }

      if (vitalsResult.status === 'fulfilled') setVitals(vitalsResult.value);
      else { setVitals([]); issues.push('vitals'); }

      if (opdResult.status === 'fulfilled') setOpdVisits(opdResult.value);
      else { setOpdVisits([]); issues.push('OPD history'); }

      if (serviceResult.status === 'fulfilled') setServices(serviceResult.value);
      else { setServices([]); issues.push('ApexCare service cases'); }

      const [medsResult, prescriptionResult] = await Promise.allSettled([
        medications(patientId), refreshPrescriptionWorkflow(),
      ]);
      if (medsResult.status === 'fulfilled') setMedicationList(medsResult.value);
      else { setMedicationList([]); issues.push('medications'); }
      if (prescriptionResult.status === 'rejected') {
        setPrescriptions([]);
        setPrescriptionDrafts({});
        issues.push('prescription documents');
      } else if (prescriptionResult.value.draftFailures > 0) {
        issues.push('some prescription draft details');
      }

      if (coordinator) {
        const communicationResult = await Promise.allSettled([carePlanCommunications(patientId)]);
        if (communicationResult[0].status === 'fulfilled') setCommunications(communicationResult[0].value);
        else { setCommunications([]); issues.push('communication history'); }
      }

      if (clinician) {
        const [labsResult, signalResult, draftsResult, summaryResult] = await Promise.allSettled([
          labDocuments(patientId), clinicalSignals(patientId), drafts(patientId), progressSummary(patientId),
        ]);

        if (labsResult.status === 'fulfilled') {
          setLabDocs(labsResult.value);
          const entries = await Promise.all(labsResult.value.slice(0, 8).map(async (doc) => {
            const [resultSet, interpretation] = await Promise.allSettled([
              labResults(patientId, doc._id), labInterpretation(patientId, doc._id),
            ]);
            return [doc._id, {
              results: resultSet.status === 'fulfilled' ? resultSet.value.results : [],
              interpretation: interpretation.status === 'fulfilled' ? interpretation.value : undefined,
              resultsRequestFailed: resultSet.status === 'rejected',
            }] as const;
          }));
          setLabData(Object.fromEntries(entries.map(([documentId, value]) => [documentId, { results: value.results, interpretation: value.interpretation }])));
          if (entries.some(([, value]) => value.resultsRequestFailed)) issues.push('some laboratory result details');
        } else { setLabDocs([]); setLabData({}); issues.push('laboratory reports'); }

        if (signalResult.status === 'fulfilled') setSignals(signalResult.value);
        else { setSignals([]); issues.push('clinical signals'); }
        if (draftsResult.status === 'fulfilled') setCareDrafts(draftsResult.value);
        else { setCareDrafts([]); issues.push('care-plan drafts'); }
        if (summaryResult.status === 'fulfilled') setClinicalSummary(summaryResult.value);
        else { setClinicalSummary(null); issues.push('clinical progress summary'); }
      }

      if (carePlanResult.status === 'fulfilled') {
        const selectedPlan = carePlanResult.value.find((plan) => plan.status === 'ACTIVE') || carePlanResult.value[0];
        if (selectedPlan) {
          const executionResult = await Promise.allSettled([carePlanExecution(patientId, selectedPlan._id)]);
          if (executionResult[0].status === 'fulfilled') setExecution(executionResult[0].value);
          else { setExecution(null); issues.push('care-plan execution details'); }
        } else {
          setExecution(null);
        }
      }

      const uniqueIssues = [...new Set(issues)];
      setDataIssues(uniqueIssues);
      setLastUpdated(new Date().toISOString());
    } finally {
      setPatientLoading(false);
      setRefreshing(false);
    }
  }, [patientId, coordinator, clinician, refreshPrescriptionWorkflow]);

  useEffect(() => {
    if (!rolesLoaded) return;
    let active = true;
    refresh().catch((error) => {
      if (active) setPatientLoadError(error instanceof Error ? error.message : 'Unable to load patient.');
    });
    return () => { active = false; };
  }, [refresh, rolesLoaded]);

  useEffect(() => {
    let active = true;
    prescriptionOcrStatus()
      .then((status) => { if (active) setPrescriptionOcrRuntimeStatus(status); })
      .catch(() => { if (active) setPrescriptionOcrRuntimeStatus(null); });
    return () => { active = false; };
  }, []);

  const prescriptionAnalysisPending = prescriptions.some((document) =>
    document.analysisStatus === 'PENDING' || document.analysisStatus === 'PROCESSING' || document.status === 'ANALYZING'
  );

  useEffect(() => {
    if (!prescriptionAnalysisPending) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const documents = await prescriptionDocuments(patientId);
        if (cancelled) return;
        setPrescriptions(documents);
        const entries = await Promise.all(documents.slice(0, 6).map(async (document) => {
          try { return [document._id, await medicationDrafts(patientId, document._id)] as const; }
          catch { return [document._id, []] as const; }
        }));
        if (cancelled) return;
        setPrescriptionDrafts(Object.fromEntries(entries));
        const stillPending = documents.some((document) =>
          document.analysisStatus === 'PENDING' || document.analysisStatus === 'PROCESSING' || document.status === 'ANALYZING'
        );
        if (stillPending) timer = window.setTimeout(poll, 4000);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 6000);
      }
    };

    timer = window.setTimeout(poll, 3500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [patientId, prescriptionAnalysisPending]);

  async function handleMilestone(milestoneId: string, action: 'COMPLETE' | 'SKIP') {
    if (!activePlan) return;
    setClinicalActionBusy(`milestone:${milestoneId}`);
    try {
      const result = await transitionMilestone(patientId, activePlan._id, milestoneId, action);
      if (execution) {
        setExecution({ ...execution, milestones: execution.milestones.map((item) => String(item._id) === milestoneId ? { ...item, ...(result as { milestone?: Record<string, unknown> }).milestone } : item) });
      }
      setMessage(action === 'COMPLETE' ? 'Milestone marked complete.' : 'Milestone skipped.');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to update the care milestone.'); } finally { setClinicalActionBusy(null); }
  }

  async function handleVitalsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const systolic = vitalsForm.systolic.trim();
    const diastolic = vitalsForm.diastolic.trim();
    if (Boolean(systolic) !== Boolean(diastolic)) {
      setMessage('Enter both systolic and diastolic blood pressure, or leave both blank.');
      return;
    }
    if (systolic && diastolic && Number(systolic) <= Number(diastolic)) {
      setMessage('Systolic blood pressure should be greater than diastolic blood pressure. Check the reading before saving.');
      return;
    }
    const payload: Parameters<typeof recordCoordinatorVitals>[1] = {
      recordedAt: new Date().toISOString(),
      source: vitalsForm.source,
      symptoms: vitalsForm.symptoms.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
      notes: vitalsForm.notes.trim() || undefined,
    };
    if (systolic && diastolic) {
      payload.bloodPressure = {
        systolic: Number(systolic),
        diastolic: Number(diastolic),
        ...(vitalsForm.pulse.trim() ? { pulse: Number(vitalsForm.pulse) } : {}),
      };
    } else if (vitalsForm.pulse.trim()) {
      setMessage('Enter blood pressure with pulse, or clear the pulse field.');
      return;
    }
    if (vitalsForm.weightKg.trim()) payload.weightKg = Number(vitalsForm.weightKg);
    if (vitalsForm.bloodSugar.trim()) {
      payload.bloodSugar = { value: Number(vitalsForm.bloodSugar), type: vitalsForm.bloodSugarType, unit: 'MG_DL' };
    }
    if (!payload.bloodPressure && !payload.weightKg && !payload.bloodSugar && !payload.symptoms?.length) {
      setMessage('Enter at least one measurement or symptom before saving.');
      return;
    }
    const validNumeric = [payload.bloodPressure?.systolic, payload.bloodPressure?.diastolic, payload.bloodPressure?.pulse, payload.weightKg, payload.bloodSugar?.value]
      .filter((value) => value !== undefined).every((value) => Number.isFinite(value));
    if (!validNumeric) {
      setMessage('Measurements must be valid numbers.');
      return;
    }
    setVitalsBusy(true);
    try {
      await recordCoordinatorVitals(patientId, payload);
      setVitalsForm({ systolic: '', diastolic: '', pulse: '', weightKg: '', bloodSugar: '', bloodSugarType: 'RANDOM', symptoms: '', notes: '', source: 'OPD' });
      setMessage('Vitals saved successfully.');
      setSection('vitals');
      try {
        await refresh();
      } catch {
        setMessage('Vitals were saved, but Patient 360 could not refresh all data. Use Refresh Data to retry.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save vitals.');
    } finally {
      setVitalsBusy(false);
    }
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

  async function handleOpdSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    if (!roles.userId || String(patient?.assignedClinicianId || '') !== roles.userId) {
      setMessage('Only the assigned clinician can document this OPD visit.');
      return;
    }
    if (!opdForm.reason.trim()) {
      setMessage('Enter a reason for the OPD visit.');
      return;
    }
    setOpdBusy(true);
    try {
      await createOpdVisit(patientId, {
        clinicianId: roles.userId,
        visitAt: new Date().toISOString(),
        reason: opdForm.reason.trim(),
        assessment: opdForm.assessment.trim() || undefined,
        planAdjustment: opdForm.planAdjustment.trim() || undefined,
        carePlanId: activePlan?._id,
        vitalsRecordId: opdForm.vitalsRecordId || undefined,
      });
      setOpdForm({ reason: 'Chronic care follow-up', assessment: '', planAdjustment: '', vitalsRecordId: '' });
      setMessage('OPD visit saved successfully.');
      setSection('opd');
      try {
        await refresh();
      } catch {
        setMessage('The OPD visit was saved, but Patient 360 could not refresh all data. Use Refresh Data to retry.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save OPD visit.');
    } finally {
      setOpdBusy(false);
    }
  }

  function openContactEditor() {
    if (!patient) return;
    setContactForm({
      phone: patient.phone || '',
      whatsapp: patient.whatsapp || '',
      preferredLanguage: patient.preferredLanguage || 'en',
      preferredContactChannel: patient.preferredContactChannel || 'PHONE',
    });
    setContactEditOpen(true);
    setMessage('');
  }

  async function handleContactProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!coordinator && !admin) {
      setMessage('Only clinic coordinators and clinic admins can update contact details.');
      return;
    }
    const phone = contactForm.phone.trim();
    if (phone && phone.length < 7) {
      setMessage('Enter a valid phone number with at least 7 characters.');
      return;
    }
    if (!phone || phone.length < 7) {
      setMessage('Enter a valid primary phone number (at least 7 characters).');
      return;
    }
    const language = contactForm.preferredLanguage.trim();
    if (language.length < 2) {
      setMessage('Enter a preferred language code or name (at least 2 characters).');
      return;
    }
    if (contactForm.preferredContactChannel === 'WHATSAPP' && !contactForm.whatsapp.trim()) {
      setMessage('Add a WhatsApp number or choose another preferred contact channel.');
      return;
    }
    setContactSaving(true);
    setMessage('');
    try {
      const payload = {
        phone,
        whatsapp: contactForm.whatsapp.trim(),
        preferredLanguage: language,
        preferredContactChannel: contactForm.preferredContactChannel,
      };
      const updated = await updatePatientContactProfile(patientId, payload);
      setPatient(updated);
      setContactEditOpen(false);
      setMessage('Patient contact details updated.');
      try {
        await refresh();
      } catch {
        setMessage('Contact details were saved, but Patient 360 could not refresh all data. Use Refresh Data to retry.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update contact details.');
    } finally {
      setContactSaving(false);
    }
  }

  async function togglePrescriptionImage(documentId: string) {
    const existing = prescriptionImageUrls[documentId];
    if (existing) {
      URL.revokeObjectURL(existing);
      setPrescriptionImageUrls((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
      return;
    }
    setPrescriptionImageBusyId(documentId);
    setPrescriptionImageErrors((current) => ({ ...current, [documentId]: '' }));
    try {
      const blob = await prescriptionImage(patientId, documentId);
      const url = URL.createObjectURL(blob);
      prescriptionObjectUrls.current.push(url);
      setPrescriptionImageUrls((current) => ({ ...current, [documentId]: url }));
    } catch (error) {
      setPrescriptionImageErrors((current) => ({ ...current, [documentId]: error instanceof Error ? error.message : 'Unable to load the original prescription.' }));
    } finally {
      setPrescriptionImageBusyId(null);
    }
  }

  async function handlePrescriptionCapture(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setPrescriptionMessage('Please choose a JPG, PNG, or WebP prescription image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPrescriptionMessage('The prescription image must be 5 MB or smaller. Retake or resize the image and try again.');
      return;
    }
    setPrescriptionUploadBusy(true);
    setPrescriptionMessage(null);
    try {
      await uploadPrescription(patientId, file);
      setPrescriptionMessage('Prescription captured. Recognition is running in the background; results will update automatically.');
      await refresh();
    } catch (error) {
      setPrescriptionMessage(error instanceof Error ? error.message : 'Unable to capture the prescription.');
    } finally { setPrescriptionUploadBusy(false); }
  }

  function updateDraftMedicationField(
    draftId: string,
    initialMedications: DraftMedicationFields,
    index: number,
    field: DraftMedicationEditableField,
    value: string,
  ) {
    setEditedDraftMedications((current) => {
      const list = [...(current[draftId] ?? initialMedications)];
      const existing = list[index];
      if (!existing) return current;
      list[index] = { ...existing, [field]: value, confidence: undefined, sourceText: undefined };
      return { ...current, [draftId]: list };
    });
  }

  function addDraftMedication(draftId: string, initialMedications: DraftMedicationFields) {
    setEditedDraftMedications((current) => ({
      ...current,
      [draftId]: [...(current[draftId] ?? initialMedications), { name: '' }],
    }));
  }

  function removeDraftMedication(draftId: string, initialMedications: DraftMedicationFields, index: number) {
    setEditedDraftMedications((current) => ({
      ...current,
      [draftId]: (current[draftId] ?? initialMedications).filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function handleDraftSubmit(documentId: string, draft: MedicationDraft) {
    const candidates = (editedDraftMedications[draft._id] ?? draft.medications ?? []).map((medication) => ({
      ...medication,
      name: medication.name.trim(),
    }));
    if (!candidates.length || candidates.some((medication) => !medication.name)) {
      setPrescriptionMessage('Add at least one medicine and provide a name for every row before submitting.');
      return;
    }
    setClinicalActionBusy(`draft:${draft._id}`);
    setPrescriptionMessage(null);
    try {
      await submitMedicationDraft(patientId, documentId, draft._id, candidates);
      setPrescriptionMessage('Medication list submitted for verification. The OCR output remains a draft until the clinical review is complete.');
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
  const bloodPressureVitals = useMemo(() => vitals.filter((item) => item.bloodPressure?.systolic !== undefined), [vitals]);

  const latestBP = latestVital?.bloodPressure;

  const activePlan =
    carePlans.find((plan) => plan.status === "ACTIVE") || carePlans[0];

  const latestOPD = opdVisits[0];

  const currentConditions = useMemo(() => {
    const fromDiagnoses = diagnosesList.filter((item) => item.status !== 'INACTIVE').map((item) => item.condition);
    const fromPatient = (patient?.conditions || []).filter((item) => item.status !== 'INACTIVE').map((item) => item.code);
    return [...new Set([...fromDiagnoses, ...fromPatient])];
  }, [diagnosesList, patient]);

  const nextMilestone = useMemo(() => {
    const milestones = execution?.milestones || [];
    return milestones
      .filter((item) => !['COMPLETED', 'SKIPPED', 'CANCELLED'].includes(String(item.status || '').toUpperCase()))
      .sort((a, b) => new Date(String(a.dueAt || a.scheduledAt || 0)).getTime() - new Date(String(b.dueAt || b.scheduledAt || 0)).getTime())[0];
  }, [execution]);

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
          <div className="card glass patient360-load-state" style={{ marginTop: 12 }}>
            {patientLoadError ? (
              <div role="alert" className="patient360-load-error">
                <AlertTriangle size={20} />
                <div><b>Patient record could not be loaded</b><p>{patientLoadError}</p>
                  <button type="button" className="primary" disabled={refreshing} onClick={() => { void refresh().catch(() => undefined); }}>
                    <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Try again
                  </button>
                </div>
              </div>
            ) : <><RefreshCw size={18} className="spin" /> {patientLoading || !rolesLoaded ? 'Loading patient workspace…' : 'Patient record not available yet.'}</>}
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
                        {(currentConditions.length ? currentConditions.map((condition) => condition.replaceAll('_', ' ')).join(' · ') : 'Diagnosis pending')} · Awaiting enrolment
                      </p>
                    </div>
                  </div>

                  <div className="patient360-status">
                    <Badge s="NOT_ENROLLED" />
                    {diagnosesList[0] && <Badge s={diagnosesList[0].status} />}
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
                  <div className="eyebrow">Patient clinical workspace</div>

                  <h2>
                    {patient.name.first} {patient.name.last}
                  </h2>

                  <p>
                    {patient.medicalRecordNumber || "No MRN"}
                    {" · "}
                    {patient.phone || "No phone"}
                    {patient.dateOfBirth ? ` · DOB ${new Date(patient.dateOfBirth).toLocaleDateString()}` : ''}
                  </p>
                  <div className="patient360-condition-tags">
                    {currentConditions.length ? currentConditions.map((condition) => <span className="badge blue" key={condition}>{condition.replaceAll('_', ' ')}</span>) : <span className="muted">No structured diagnosis recorded</span>}
                  </div>
                </div>
              </div>

              <div className="patient360-status">
                <Badge s={patient.enrollmentStatus} />

                {diagnosesList[0] && <Badge s={diagnosesList[0].status} />}

                {clinician && patient.enrollmentStatus === "CARE_PLAN_REVIEW" && (
                  <span className="badge warn">Care plan review pending</span>
                )}
              </div>
            </section>

            <section className="patient360-actionbar card glass" aria-label="Patient actions">
              <div className="patient360-action-context">
                <b>Quick actions</b>
                <span className="muted">{lastUpdated ? `Data refreshed ${new Date(lastUpdated).toLocaleTimeString()}` : 'Data status not yet confirmed'}</span>
              </div>
              <div className="patient360-action-buttons">
                {patient.phone && <a className="secondary" href={`tel:${patient.phone}`}><Phone size={14} /> Call patient</a>}
                {coordinator && <Link className="secondary" href="/reviews"><ClipboardList size={14} /> Reviews</Link>}
                <button type="button" className="secondary" onClick={() => setSection('vitals')}><HeartPulse size={14} /> Record vitals</button>
                <button type="button" className="secondary" onClick={() => setSection('medications')}><FileText size={14} /> Prescriptions</button>
                <button type="button" className="primary" onClick={() => { void refresh().catch(() => undefined); }} disabled={refreshing} aria-busy={refreshing}>
                  <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh data'}
                </button>
              </div>
            </section>

            {dataIssues.length > 0 && <div className="patient360-data-warning" role="status">
              <AlertTriangle size={17} />
              <div><b>Some patient data could not be refreshed</b><span>Unavailable: {dataIssues.join(', ')}. Other sections may still be current.</span></div>
              <button type="button" className="secondary" disabled={refreshing} onClick={() => { void refresh().catch(() => undefined); }}>Retry</button>
            </div>}
            {patientLoadError && <div className="patient360-data-warning" role="alert">
              <AlertTriangle size={17} />
              <div><b>Patient record refresh failed</b><span>{patientLoadError} The last successfully loaded patient details remain visible; retry before relying on fresh data.</span></div>
              <button type="button" className="secondary" disabled={refreshing} onClick={() => { void refresh().catch(() => undefined); }}>Retry</button>
            </div>}

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
                <span>Next milestone</span>
                <strong>{nextMilestone ? String(nextMilestone.title || nextMilestone.name || nextMilestone.key || 'Due') : '—'}</strong>
                <small>{nextMilestone && (nextMilestone.dueAt || nextMilestone.scheduledAt) ? new Date(String(nextMilestone.dueAt || nextMilestone.scheduledAt)).toLocaleDateString() : 'No upcoming milestone loaded'}</small>
              </div>
            </div>

            {/* =================================================
                GLOBAL MESSAGE
                ================================================= */}

            {message && (
              <div className="alert patient360-flash" role="status" style={{ marginTop: 14 }}>
                <span>{message}</span>
                <button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setMessage('')}><X size={14} /></button>
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
                ...(clinician ? [["labs", "Labs"]] : []),
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
                  <section className="card glass">
                    <div className="section-head"><div><div className="eyebrow">Patient profile</div><h2>Identity and contact</h2></div><ShieldCheck size={18} /></div>
                    <div className="patient360-detail-grid">
                      <div><span>Medical record number</span><b>{patient.medicalRecordNumber || 'Not recorded'}</b></div>
                      <div><span>Phone</span>{patient.phone ? <a href={`tel:${patient.phone}`}>{patient.phone}</a> : <b>Not recorded</b>}</div>
                      <div><span>WhatsApp</span>{patient.whatsapp ? <a href={whatsappHref(patient.whatsapp)} target="_blank" rel="noreferrer">{patient.whatsapp}</a> : <b>Not recorded</b>}</div>
                      <div><span>Date of birth / age</span><b>{patient.dateOfBirth ? `${new Date(patient.dateOfBirth).toLocaleDateString()} · ${Math.max(0, Math.floor((Date.now() - new Date(patient.dateOfBirth).getTime()) / (365.2425 * 24 * 60 * 60 * 1000)))} yrs` : 'Not recorded'}</b></div>
                      <div><span>Sex at birth</span><b>{patient.sexAtBirth ? patient.sexAtBirth.replaceAll('_', ' ') : 'Not recorded'}</b></div>
                      <div><span>Preferred contact</span><b>{patient.preferredContactChannel || 'PHONE'}</b></div>
                      <div><span>Preferred language</span><b>{patient.preferredLanguage || 'Not recorded'}</b></div>
                      <div><span>Assigned clinician</span><b>{patient.assignedClinicianName || (patient.assignedClinicianId ? 'Assigned (name unavailable)' : 'Not assigned')}</b></div>
                      {patient.contactProfileLastUpdatedAt && <div><span>Contact details last updated</span><b>{new Date(patient.contactProfileLastUpdatedAt).toLocaleString()}</b></div>}
                    </div>
                    {(coordinator || admin) && !contactEditOpen && <div className="patient360-profile-actions"><button type="button" className="secondary" onClick={openContactEditor}>Edit contact details</button></div>}
                    {contactEditOpen && (coordinator || admin) && <form className="patient360-vitals-form patient360-contact-form" onSubmit={handleContactProfileSubmit}>
                      <div className="section-head"><div><h3>Update contact details</h3><p className="muted">Updates are saved to the existing patient record and scoped to this clinic.</p></div></div>
                      <div className="patient360-form-grid">
                        <label>Phone *<input type="tel" autoComplete="tel" required minLength={7} maxLength={25} value={contactForm.phone} onChange={(event) => setContactForm((current) => ({ ...current, phone: event.target.value }))} placeholder="Patient phone number" /></label>
                        <label>WhatsApp<input type="tel" autoComplete="tel" maxLength={25} value={contactForm.whatsapp} onChange={(event) => setContactForm((current) => ({ ...current, whatsapp: event.target.value }))} placeholder="Leave blank if unavailable" /></label>
                        <label>Preferred language<input maxLength={20} value={contactForm.preferredLanguage} onChange={(event) => setContactForm((current) => ({ ...current, preferredLanguage: event.target.value }))} placeholder="e.g. ml, en" /></label>
                        <label>Preferred contact channel<select value={contactForm.preferredContactChannel} onChange={(event) => setContactForm((current) => ({ ...current, preferredContactChannel: event.target.value as typeof current.preferredContactChannel }))}><option value="PHONE">Phone call</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option><option value="APP">App notification</option></select></label>
                      </div>
                      <div className="patient360-form-footer"><span className="muted">Changing the phone does not send a message automatically.</span><div className="toolbar"><button type="button" className="secondary" disabled={contactSaving} onClick={() => setContactEditOpen(false)}>Cancel</button><button type="submit" className="primary" disabled={contactSaving}>{contactSaving ? 'Saving…' : 'Save contact details'}</button></div></div>
                    </form>}
                    <p className="patient360-readonly-hint">Diagnosis, enrolment status and clinician assignment remain outside this contact-edit form.</p>
                  </section>

                  <section className="card glass">
                    <div className="section-head"><div><div className="eyebrow">Longitudinal record</div><h2>Diagnoses and conditions</h2></div><Activity size={18} /></div>
                    {diagnosesList.length ? diagnosesList.map((item) => <div className="patient360-diagnosis-row" key={item._id}>
                      <div><b>{item.condition.replaceAll('_', ' ')}</b><span>Diagnosed {item.diagnosedAt ? new Date(item.diagnosedAt).toLocaleDateString() : 'date not recorded'}{item.source ? ` · ${item.source.replaceAll('_', ' ')}` : ''}</span></div>
                      <Badge s={item.status} />
                    </div>) : currentConditions.length ? (patient.conditions || []).filter((condition) => condition.status !== 'INACTIVE').map((condition) => <div className="patient360-diagnosis-row" key={condition.code}>
                      <div><b>{condition.code.replaceAll('_', ' ')}</b><span>Patient summary · diagnosed {condition.diagnosedAt ? new Date(condition.diagnosedAt).toLocaleDateString() : 'date not recorded'}</span></div><Badge s={condition.status} />
                    </div>) : <div className="empty-state compact">No structured diagnosis records were returned. Refresh or ask the assigned clinician to confirm the diagnosis.</div>}
                  </section>

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

                      const plan = draft.plan as
                        | {
                            goals?: Array<{
                              title: string;
                              target?: string;
                            }>;
                          }
                        | undefined;

                      return (
                        <div className="draft-card" key={id}>
                          <div className="section-head">
                            <b>Draft {index + 1}</b>

                            <Badge s={status} />
                          </div>

                          {plan?.goals?.map((goal) => (
                            <div className="mini-item" key={goal.title}>
                              <b>{goal.title}</b>

                              <span>{goal.target || ""}</span>
                            </div>
                          ))}

                          {(status === "GENERATED" || status === "CLINICIAN_REVIEW") && (
                            <div className="toolbar">
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => reject(id)}
                              >
                                <X size={14} />
                                Reject
                              </button>

                              <button
                                className="primary"
                                disabled={busy}
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
                  <div className="section-head"><div><div className="eyebrow">New measurement</div><h2>Record patient vitals</h2><p className="muted">Saved to the patient record with the current timestamp and selected source.</p></div><HeartPulse size={19} color="#1677ff" /></div>
                  <form className="patient360-vitals-form" onSubmit={handleVitalsSubmit}>
                    <label>Reading source<select value={vitalsForm.source} onChange={(event) => setVitalsForm((current) => ({ ...current, source: event.target.value as 'OPD' | 'HOME' | 'DEVICE' }))}><option value="OPD">Clinic / OPD</option><option value="HOME">Reported from home</option><option value="DEVICE">Device</option></select></label>
                    <div className="patient360-form-grid">
                      <label>Systolic BP (mmHg)<input inputMode="decimal" type="number" min="40" max="300" value={vitalsForm.systolic} onChange={(event) => setVitalsForm((current) => ({ ...current, systolic: event.target.value }))} placeholder="e.g. 130" /></label>
                      <label>Diastolic BP (mmHg)<input inputMode="decimal" type="number" min="20" max="200" value={vitalsForm.diastolic} onChange={(event) => setVitalsForm((current) => ({ ...current, diastolic: event.target.value }))} placeholder="e.g. 80" /></label>
                      <label>Pulse (bpm)<input inputMode="decimal" type="number" min="20" max="250" value={vitalsForm.pulse} onChange={(event) => setVitalsForm((current) => ({ ...current, pulse: event.target.value }))} placeholder="Optional" /></label>
                      <label>Weight (kg)<input inputMode="decimal" type="number" min="1" max="500" step="0.1" value={vitalsForm.weightKg} onChange={(event) => setVitalsForm((current) => ({ ...current, weightKg: event.target.value }))} placeholder="Optional" /></label>
                      <label>Blood glucose (mg/dL)<input inputMode="decimal" type="number" min="10" max="1000" step="0.1" value={vitalsForm.bloodSugar} onChange={(event) => setVitalsForm((current) => ({ ...current, bloodSugar: event.target.value }))} placeholder="Optional" /></label>
                      <label>Glucose type<select value={vitalsForm.bloodSugarType} onChange={(event) => setVitalsForm((current) => ({ ...current, bloodSugarType: event.target.value as typeof current.bloodSugarType }))}><option value="FASTING">Fasting</option><option value="POST_PRANDIAL">Post-prandial</option><option value="RANDOM">Random</option></select></label>
                    </div>
                    <label>Symptoms / concerns<textarea maxLength={2000} rows={2} value={vitalsForm.symptoms} onChange={(event) => setVitalsForm((current) => ({ ...current, symptoms: event.target.value }))} placeholder="Optional; separate multiple items with commas or new lines" /></label>
                    <label>Measurement notes<textarea maxLength={2000} rows={2} value={vitalsForm.notes} onChange={(event) => setVitalsForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional context for the clinical team" /></label>
                    <div className="patient360-form-footer"><span className="muted">A record is saved only when you submit this form.</span><button type="submit" className="primary" disabled={vitalsBusy}>{vitalsBusy ? <><RefreshCw size={14} className="spin" /> Saving…</> : <><Check size={14} /> Save vitals</>}</button></div>
                  </form>
                </section>
                <section className="card glass">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Longitudinal monitoring</div>

                      <h2>Blood pressure</h2>
                    </div>

                    <HeartPulse size={19} color="#1677ff" />
                  </div>

                  <div className="chart">
                    {bloodPressureVitals
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
                    {!bloodPressureVitals.length && <div className="empty-state compact">No blood-pressure measurements available to chart.</div>}
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
                            : item.bloodSugar
                              ? `${item.bloodSugar.value} ${item.bloodSugar.unit === 'PERCENT' ? '%' : 'mg/dL'}`
                              : item.weightKg ? `${item.weightKg} kg` : 'Recorded measurement'}
                        </b>
                        <span className="muted">{new Date(item.recordedAt).toLocaleString()}</span>
                      </div>
                      <p>
                        {item.source || 'Recorded'}
                        {item.bloodPressure?.pulse ? ` · Pulse ${item.bloodPressure.pulse} bpm` : ''}
                        {item.bloodSugar ? ` · ${item.bloodSugar.type.replaceAll('_', ' ')} glucose` : ''}
                        {item.weightKg ? ` · ${item.weightKg} kg` : ''}
                      </p>
                      {item.symptoms?.length ? <p>Symptoms: {item.symptoms.join(', ')}</p> : null}
                      {item.notes ? <p className="muted">{item.notes}</p> : null}
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

            {clinician && section === "labs" && (
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

                        {!!data?.results?.length && (
                          <div className="lab-result-grid">
                            {data.results.map((result) => (
                              <div className={`lab-result ${result.abnormalFlag !== 'NORMAL' ? 'abnormal' : ''}`} key={result._id}>
                                <div><span>{result.testName}</span><b>{result.valueText}{result.unit ? ` ${result.unit}` : ''}</b></div>
                                <small>{result.abnormalFlag !== 'NORMAL' ? result.abnormalFlag : result.referenceRangeText || 'Within reference range'}</small>
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
                <div className="section-head"><div><div className="eyebrow">Prescription workflow output</div><h2>Medication history</h2></div><Pill size={18} color="#1677ff" /></div>
                <p className="muted">Verified medication records are shown with their current status. OCR candidates remain drafts until the clinical verification workflow is complete.</p>
                {!medicationList.length && <div className="empty-state">No medication records are available.</div>}
                {!!medicationList.filter((medication) => medication.status === 'ACTIVE').length && <h3 className="patient360-subheading">Active medicines</h3>}
                <div className="medication-grid">
                  {medicationList.filter((medication) => medication.status === 'ACTIVE').map((medication) => (
                    <div className="medication-card" key={medication._id}>
                      <div className="medication-icon"><Pill size={17}/></div>
                      <div><b>{medication.name}</b><span>{[medication.strength, medication.dose].filter(Boolean).join(' · ') || 'Dose not recorded'}</span><small>{medication.frequency || 'Frequency not recorded'}{medication.route ? ` · ${medication.route}` : ''}</small>{medication.instructions && <p>{medication.instructions}</p>}</div>
                      <Badge s={medication.status} />
                    </div>
                  ))}
                </div>
                {!!medicationList.filter((medication) => medication.status !== 'ACTIVE').length && <>
                  <h3 className="patient360-subheading">Discontinued medicines</h3>
                  <div className="medication-grid">
                    {medicationList.filter((medication) => medication.status !== 'ACTIVE').map((medication) => (
                      <div className="medication-card" key={medication._id}>
                        <div className="medication-icon"><Pill size={17}/></div>
                        <div><b>{medication.name}</b><span>{[medication.strength, medication.dose].filter(Boolean).join(' · ') || 'Dose not recorded'}</span><small>{medication.frequency || 'Frequency not recorded'}{medication.route ? ` · ${medication.route}` : ''}</small>{medication.discontinuedAt && <small>Discontinued {new Date(medication.discontinuedAt).toLocaleDateString()}</small>}</div>
                        <Badge s={medication.status} />
                      </div>
                    ))}
                  </div>
                </>}

                {coordinator && (
                  <>
                    <div className="section-head" style={{ marginTop: 24 }}><div><div className="eyebrow">Prescription capture</div><h2>Capture a new prescription</h2><span className="muted">Clinic coordinator captures the source prescription; analysis happens in the background.</span></div><FileText size={18} /></div>
                    <label className="camera-capture glass-subtle">
                      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handlePrescriptionCapture(file); event.currentTarget.value = ''; }} disabled={prescriptionUploadBusy} />
                      <span className="camera-capture-icon">{prescriptionUploadBusy ? <RefreshCw className="spin" size={20}/> : <FileText size={20}/>}</span>
                      <span><b>{prescriptionUploadBusy ? 'Capturing prescription…' : 'Take prescription photo'}</b><small>Clear, well-lit image · JPG, PNG or WebP</small></span>
                    </label>
                    {prescriptionMessage && <div className="inline-feedback page-enter">{prescriptionMessage}</div>}
                    {prescriptionOcrRuntimeStatus && !prescriptionOcrRuntimeStatus.configured && <div className="ocr-configuration-warning" role="status"><AlertTriangle size={17} /><div><b>Prescription recognition is not configured</b><span>The image can still be securely captured, but automated extraction will not run until the backend OCR endpoint or vision fallback is configured. Failed extraction must be handled through clinician review.</span></div></div>}
                    {prescriptionOcrRuntimeStatus?.configured && <p className="muted ocr-runtime-note">Recognition provider configured: {prescriptionOcrRuntimeStatus.provider === 'paddleocr-vl' ? 'PaddleOCR-VL full layout-parsing pipeline' : prescriptionOcrRuntimeStatus.provider === 'openai-compatible' ? 'OpenAI-compatible vision endpoint' : 'OpenAI-compatible vision fallback'}. OCR output remains unverified until a clinician checks it against the original image.</p>}
                    {prescriptionOcrRuntimeStatus?.configured && prescriptionOcrRuntimeStatus.provider === 'paddleocr-vl' && !prescriptionOcrRuntimeStatus.medicationStructuringConfigured && <div className="ocr-configuration-warning" role="status"><AlertTriangle size={17} /><div><b>Text recognition is configured; medication field extraction is not</b><span>PaddleOCR will return the recognized text, but a chat-completions-compatible text model must be configured with AI_ENABLED, AI_BASE_URL, AI_API_KEY, and AI_MODEL to structure it into medicine candidates. Do not use candidates without clinician verification.</span></div></div>}
                  </>
                )}
                {!prescriptions.length && <div className="empty-state">No prescription documents captured yet.</div>}
                {prescriptions.map((document) => {
                  const documentDrafts = prescriptionDrafts[document._id] || [];
                  const isAnalyzing = document.analysisStatus === 'PENDING' || document.analysisStatus === 'PROCESSING' || document.status === 'ANALYZING';
                  return (
                    <div className="prescription-row" key={document._id}>
                      <div className="service-icon"><FileText size={16}/></div>
                      <div className="prescription-document-main">
                        <b>{document.fileName || 'Prescription document'}</b>
                        <span>{document.capturedAt ? new Date(document.capturedAt).toLocaleString() : 'Captured prescription'}</span>
                        <small>{isAnalyzing ? 'OCR recognition is processing…' : document.analysisStatus || document.status || 'PENDING'}</small>
                        {document.clinicalReviewReason && <p className="ocr-review-note">{document.clinicalReviewReason}</p>}
                      </div>
                      <div className="prescription-document-actions">
                        <Badge s={isAnalyzing ? 'PENDING' : document.analysisStatus || document.status} />
                        <button type="button" className="secondary" disabled={prescriptionImageBusyId === document._id} onClick={() => void togglePrescriptionImage(document._id)}>
                          {prescriptionImageBusyId === document._id ? <><RefreshCw size={13} className="spin" /> Loading image…</> : prescriptionImageUrls[document._id] ? 'Hide original image' : 'View original image'}
                        </button>
                      </div>
                      {prescriptionImageErrors[document._id] && <div className="inline-feedback" role="alert">{prescriptionImageErrors[document._id]}</div>}
                      {prescriptionImageUrls[document._id] && <div className="prescription-original-image"><img src={prescriptionImageUrls[document._id]} alt={`Original prescription ${document.fileName || ''}`} /><p className="muted">Compare the original prescription image before verifying any extracted medication. The image remains in this browser session only.</p></div>}
                      {isAnalyzing && <div className="ocr-progress-note"><RefreshCw size={14} className="spin" /> Recognition is running. This list refreshes automatically.</div>}
                      {documentDrafts.length > 0 && <div className="ocr-draft-stack">
                        {documentDrafts.slice(0, 2).map((draft) => {
                          const initialMedications = draft.medications || [];
                          const canEditMedicationCandidates = clinician && draft.status === 'VERIFICATION_REQUIRED' && document.analysisStatus === 'COMPLETED';
                          const displayedMedications = canEditMedicationCandidates
                            ? (editedDraftMedications[draft._id] ?? initialMedications)
                            : initialMedications;
                          return (
                            <div className="ocr-draft-panel" key={draft._id}>
                              <div className="ocr-draft-heading"><div><b>Recognition result</b><span>{displayedMedications.length} medication candidate{displayedMedications.length === 1 ? '' : 's'} · {draft.status || 'PENDING'}</span></div><Badge s={draft.status} /></div>
                              {draft.clinicalReviewRequired && <p className="ocr-review-note"><AlertTriangle size={14} /> {draft.clinicalReviewReason || 'Clinician verification is required before use.'}</p>}
                              {canEditMedicationCandidates && <p className="muted ocr-editor-guidance">Confirm the medicine names and directions against the original prescription image. Correct or add a candidate before submitting; editing removes the AI confidence label because the original extraction no longer exactly matches the edited row.</p>}
                              {displayedMedications.length ? <div className="ocr-medication-list">
                                {displayedMedications.map((medication, index) => (
                                  <div className={`ocr-medication-candidate${canEditMedicationCandidates ? ' ocr-medication-editor-item' : ''}`} key={`${draft._id}-${index}`}>
                                    {canEditMedicationCandidates ? <>
                                      <label className="ocr-editor-field ocr-editor-name"><span>Medicine name *</span><input maxLength={160} value={medication.name} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'name', event.target.value)} placeholder="Medicine name from prescription" /></label>
                                      <div className="ocr-editor-fields">
                                        <label className="ocr-editor-field"><span>Strength</span><input maxLength={80} value={medication.strength || ''} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'strength', event.target.value)} placeholder="e.g. 5 mg" /></label>
                                        <label className="ocr-editor-field"><span>Dose</span><input maxLength={80} value={medication.dose || ''} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'dose', event.target.value)} placeholder="e.g. 1 tablet" /></label>
                                        <label className="ocr-editor-field"><span>Route</span><input maxLength={40} value={medication.route || ''} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'route', event.target.value)} placeholder="e.g. oral" /></label>
                                        <label className="ocr-editor-field"><span>Frequency</span><input maxLength={80} value={medication.frequency || ''} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'frequency', event.target.value)} placeholder="As written" /></label>
                                        <label className="ocr-editor-field"><span>Duration</span><input maxLength={80} value={medication.duration || ''} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'duration', event.target.value)} placeholder="As written" /></label>
                                        <label className="ocr-editor-field ocr-editor-instructions"><span>Instructions</span><input maxLength={500} value={medication.instructions || ''} onChange={(event) => updateDraftMedicationField(draft._id, initialMedications, index, 'instructions', event.target.value)} placeholder="Additional instructions" /></label>
                                      </div>
                                      <div className="ocr-editor-row-actions"><span className="muted">Candidate {index + 1}</span><button className="secondary" type="button" onClick={() => removeDraftMedication(draft._id, initialMedications, index)}>Remove medicine</button></div>
                                    </> : <>
                                      <div className="ocr-medication-candidate-main"><b>{medication.name}</b><span>{[medication.strength, medication.dose, medication.route, medication.frequency, medication.duration].filter(Boolean).join(' · ') || 'Dose/instructions not extracted'}</span>{medication.instructions && <small>{medication.instructions}</small>}{medication.sourceText && <small>Source: “{medication.sourceText}”</small>}</div>
                                      {typeof medication.confidence === 'number' && <span className={`badge ${medication.confidence >= 0.8 ? 'success' : 'warn'}`}>{Math.round(medication.confidence * 100)}% confidence</span>}
                                    </>}
                                  </div>
                                ))}
                              </div> : <div className="empty-state compact">No medication candidates were safely extracted. The clinician can enter a candidate from the original image and OCR transcription.</div>}
                              {draft.rawText && <details className="ocr-raw-text"><summary>View extracted prescription text</summary><pre>{draft.rawText}</pre></details>}
                              {canEditMedicationCandidates && <div className="ocr-actions"><button className="secondary" type="button" onClick={() => addDraftMedication(draft._id, initialMedications)}>Add medicine</button><button className="primary" disabled={clinicalActionBusy === `draft:${draft._id}`} onClick={() => void handleDraftSubmit(document._id, draft)}>{clinicalActionBusy === `draft:${draft._id}` ? 'Submitting…' : 'Submit for verification'}</button></div>}
                              {clinician && draft.status === 'VERIFIED' && !draft.clinicalReviewRequired && document.status === 'VERIFIED' && <div className="ocr-actions"><button className="primary" disabled={clinicalActionBusy === `finalize:${draft._id}`} onClick={() => void handleDraftFinalize(document._id, draft)}>{clinicalActionBusy === `finalize:${draft._id}` ? 'Finalizing…' : 'Finalize medicines'}</button></div>}
                            </div>
                          );
                        })}
                      </div>}
                    </div>
                  );
                })}
              </section>
            )}

            {/* =================================================
                OPD
                ================================================= */}

            {section === "opd" && (
              <div className="patient360-opd-stack">
              {clinician && (
                <section className="card glass">
                  <div className="section-head"><div><div className="eyebrow">Clinician documentation</div><h2>Record an OPD visit</h2><p className="muted">This creates a clinician-authored visit record. It does not replace clinic-arrival/check-in.</p></div><Stethoscope size={18} /></div>
                  {String(patient.assignedClinicianId || '') !== roles.userId ? (
                    <div className="patient360-readonly-note" role="status">This patient is not assigned to your clinician account. The backend only permits the assigned clinician to create an OPD visit.</div>
                  ) : (
                    <form className="patient360-vitals-form" onSubmit={handleOpdSubmit}>
                      <label>Reason for visit *<input required maxLength={500} value={opdForm.reason} onChange={(event) => setOpdForm((current) => ({ ...current, reason: event.target.value }))} placeholder="e.g. Day 30 hypertension follow-up" /></label>
                      <label>Clinical assessment<textarea maxLength={5000} rows={3} value={opdForm.assessment} onChange={(event) => setOpdForm((current) => ({ ...current, assessment: event.target.value }))} placeholder="Clinician assessment and relevant findings" /></label>
                      <label>Plan adjustment / next action<textarea maxLength={5000} rows={3} value={opdForm.planAdjustment} onChange={(event) => setOpdForm((current) => ({ ...current, planAdjustment: event.target.value }))} placeholder="Document clinician-approved adjustment or follow-up" /></label>
                      <label>Link saved vitals (optional)<select value={opdForm.vitalsRecordId} onChange={(event) => setOpdForm((current) => ({ ...current, vitalsRecordId: event.target.value }))}><option value="">No vitals linked</option>{vitals.slice(0, 8).map((vital) => <option key={vital._id} value={vital._id}>{new Date(vital.recordedAt).toLocaleString()} · {vital.bloodPressure ? `${vital.bloodPressure.systolic}/${vital.bloodPressure.diastolic} mmHg` : vital.bloodSugar ? `${vital.bloodSugar.value} ${vital.bloodSugar.unit}` : vital.weightKg ? `${vital.weightKg} kg` : 'Measurement'}</option>)}</select></label>
                      <div className="patient360-form-footer"><span className="muted">Only the assigned clinician can submit this visit.</span><button type="submit" className="primary" disabled={opdBusy}>{opdBusy ? <><RefreshCw size={14} className="spin" /> Saving…</> : <><Check size={14} /> Save OPD visit</>}</button></div>
                    </form>
                  )}
                </section>
              )}
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

                        <p>{visit.assessment || visit.notes || "No assessment recorded."}</p>{visit.planAdjustment && <p><b>Plan / next action:</b> {visit.planAdjustment}</p>}
                      </div>
                    </div>
                  ))}
                </div>

                {!opdVisits.length && (
                  <div className="empty-state">No OPD visits recorded.</div>
                )}
              </section>
              </div>
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