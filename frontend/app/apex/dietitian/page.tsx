'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardCheck, Clock3, RefreshCw, Send, Utensils } from 'lucide-react';
import { ApexRoleGate, ApexShell } from '@/components/ApexShell';
import { Gate } from '@/components/Shell';
import { apexDietitianQueue, submitDietitianAssessment } from '@/lib/api';
import type { ApexCareEnrollment } from '@/types/api';

type AssessmentData = {
  dietaryPattern?: string;
  foodPreferences?: string;
  allergiesOrIntolerances?: string;
  activityLevel?: string;
  nutritionGoals?: string;
};

function fullName(item: ApexCareEnrollment) {
  const name = item.patient?.name;
  return name ? [name.first, name.last].filter(Boolean).join(' ') : `Patient ${item.patientId.slice(-6)}`;
}
function activeConditions(item: ApexCareEnrollment) {
  return item.patient?.conditions?.filter((condition) => condition.status !== 'INACTIVE') ?? [];
}
function conditionText(item: ApexCareEnrollment) {
  const conditions = activeConditions(item);
  return conditions.length ? [...new Set(conditions.map((condition) => condition.code.replaceAll('_', ' ')))].join(' · ') : 'Condition not recorded';
}
function hasHypertension(item: ApexCareEnrollment) {
  return activeConditions(item).some((condition) => condition.code === 'HYPERTENSION');
}
function statusLabel(status?: string) {
  switch (status) {
    case 'NOT_STARTED': return 'Assessment needed';
    case 'QUEUED': return 'Care-plan generation queued';
    case 'PROCESSING': return 'Generating care-plan draft';
    case 'COMPLETED': return 'Draft generated';
    case 'FAILED': return 'Generation failed';
    default: return String(status || 'Unknown').replaceAll('_', ' ');
  }
}
function stringField(data: Record<string, unknown> | undefined, key: keyof AssessmentData) {
  const value = data?.[key];
  return typeof value === 'string' ? value : '';
}

export default function DietitianQueue() {
  return <Gate fallbackPath="/apex/login"><ApexRoleGate allowed={['APEXCARE_DIETITIAN']}><DietitianContent /></ApexRoleGate></Gate>;
}

function DietitianContent() {
  const [items, setItems] = useState<ApexCareEnrollment[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const [dietaryPattern, setDietaryPattern] = useState('');
  const [foodPreferences, setFoodPreferences] = useState('');
  const [allergiesOrIntolerances, setAllergiesOrIntolerances] = useState('');
  const [activityLevel, setActivityLevel] = useState('');
  const [nutritionGoals, setNutritionGoals] = useState('');
  const [queueError, setQueueError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadQueue = useCallback(async (silent = false) => {
    if (!silent) setQueueError(null);
    try {
      setItems(await apexDietitianQueue());
    } catch (e) {
      if (!silent) setQueueError(e instanceof Error ? e.message : 'Unable to load dietitian queue.');
    }
  }, []);

  useEffect(() => { void loadQueue(); }, [loadQueue]);
  useEffect(() => {
    const hasPendingGeneration = items?.some((item) => ['QUEUED', 'PROCESSING'].includes(item.carePlanGenerationStatus || ''));
    if (!hasPendingGeneration) return;
    const timer = window.setInterval(() => { void loadQueue(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [items, loadQueue]);

  const selected = useMemo(() => items?.find((item) => item._id === selectedId) ?? null, [items, selectedId]);
  const selectedEligible = Boolean(selected && hasHypertension(selected));
  const generationStatus = selected?.carePlanGenerationStatus || 'NOT_STARTED';
  const canCreateAssessment = selectedEligible && generationStatus === 'NOT_STARTED' && !selected?.assessment;
  const canRetry = selectedEligible && generationStatus === 'FAILED' && Boolean(selected?.assessment);
  const canUpdateDietChart = selectedEligible && generationStatus === 'COMPLETED';
  const formReadOnly = ['QUEUED', 'PROCESSING'].includes(generationStatus);

  function openAssessment(item: ApexCareEnrollment) {
    const data = item.assessment?.assessmentData;
    setSelectedId(item._id);
    setRemarks(item.assessment?.remarks ?? '');
    setDietaryPattern(stringField(data, 'dietaryPattern'));
    setFoodPreferences(stringField(data, 'foodPreferences'));
    setAllergiesOrIntolerances(stringField(data, 'allergiesOrIntolerances'));
    setActivityLevel(stringField(data, 'activityLevel'));
    setNutritionGoals(stringField(data, 'nutritionGoals'));
    setSubmitError(null);
    setSubmitMessage(null);
  }

  async function saveAssessment() {
    if (!selected) return;
    if (!hasHypertension(selected)) {
      setSubmitError('The current care-plan generation engine supports hypertension only. Do not submit this patient to this workflow until the appropriate condition-specific engine is enabled.');
      return;
    }
    if (canCreateAssessment && !remarks.trim()) {
      setSubmitError('Add the dietitian assessment notes before generating a draft.');
      return;
    }
    if (!canCreateAssessment && !canRetry && !canUpdateDietChart) return;

    setBusy(true);
    setSubmitError(null);
    setSubmitMessage(null);
    try {
      const result = await submitDietitianAssessment(selected.patientId, {
        remarks: remarks.trim(),
        assessmentData: {
          dietaryPattern: dietaryPattern.trim(),
          foodPreferences: foodPreferences.trim(),
          allergiesOrIntolerances: allergiesOrIntolerances.trim(),
          activityLevel: activityLevel.trim(),
          nutritionGoals: nutritionGoals.trim(),
          schemaVersion: 1,
        },
      });
      const submittedAssessment = result.assessment;
      // Reflect the accepted submission immediately; do not rely on a page reload
      // or on the queue refresh completing before the form updates.
      setItems((current) => current?.map((item) => item._id === selected._id ? {
        ...item,
        dietitianAssessmentStatus: 'COMPLETED',
        assessment: {
          remarks: submittedAssessment?.remarks ?? (canRetry ? selected.assessment?.remarks : remarks.trim()) ?? '',
          assessmentData: submittedAssessment?.assessmentData ?? (canRetry ? selected.assessment?.assessmentData : {
            dietaryPattern: dietaryPattern.trim(),
            foodPreferences: foodPreferences.trim(),
            allergiesOrIntolerances: allergiesOrIntolerances.trim(),
            activityLevel: activityLevel.trim(),
            nutritionGoals: nutritionGoals.trim(),
            schemaVersion: 1,
          }),
          completedAt: new Date().toISOString(),
        },
        carePlanGenerationStatus: result.carePlanGenerationStatus,
        carePlanGenerationJobId: result.jobId ?? item.carePlanGenerationJobId,
        carePlanDraftId: result.carePlanDraftId ?? item.carePlanDraftId,
        carePlanGenerationError: null,
      } : item) ?? current);

      if (canUpdateDietChart) {
        setSubmitMessage('Dietitian chart saved. Updates to the clinical care plan still require clinician review and approval.');
      } else if (result.carePlanGenerationStatus === 'FAILED') {
        setSubmitError('The assessment was saved, but care-plan generation failed. Review the generation status and retry when the issue is resolved.');
      } else {
        setSubmitMessage(result.carePlanGenerationStatus === 'COMPLETED'
          ? 'Assessment submitted successfully. The care-plan draft is ready for clinician review.'
          : 'Assessment submitted successfully. Care-plan generation has been queued; this screen will update automatically as the draft progresses.');
      }
      await loadQueue(true);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Unable to submit dietitian assessment.');
      // The API may have accepted the assessment before a later scheduling step
      // failed. Refresh the queue so the UI shows the server's real status.
      await loadQueue(true);
    } finally {
      setBusy(false);
    }
  }

  const pendingCount = items?.filter((item) => item.carePlanGenerationStatus === 'NOT_STARTED' && !item.assessment).length ?? 0;
  const generatingCount = items?.filter((item) => ['QUEUED', 'PROCESSING'].includes(item.carePlanGenerationStatus || '')).length ?? 0;

  return <ApexShell title="Dietitian workspace" subtitle="Record or update the dietitian-managed chart. Clinical care-plan drafts remain subject to clinician approval.">
    <section className="grid g3 section dietitian-stat-grid">
      <div className="card glass stat"><Utensils size={19} /><small>Patients handed off</small><strong>{items?.length ?? '…'}</strong></div>
      <div className="card glass stat"><ClipboardCheck size={19} /><small>Assessments to complete</small><strong>{pendingCount}</strong></div>
      <div className="card glass stat"><Clock3 size={19} /><small>Drafts processing</small><strong>{generatingCount}</strong></div>
    </section>

    <div className="apex-dietitian-layout">
      <section className="card glass page-enter apex-workflow-panel">
        <div className="section-head">
          <div><div className="eyebrow">Dietitian handoff queue</div><h2>Contacted patients</h2><span className="muted">Only enrollments marked Contacted by the coordinator enter this queue.</span></div>
          <button className="secondary compact-action" onClick={() => void loadQueue()} disabled={busy}><RefreshCw size={14} /> Refresh</button>
        </div>
        {queueError && <div className="alert alert-error" role="alert">{queueError}</div>}
        {items === null && !queueError && <div className="empty-state"><RefreshCw size={22} /><b>Loading dietitian queue</b><span>Retrieving coordinator handoffs.</span></div>}
        {items?.map((item) => {
          const eligible = hasHypertension(item);
          const isSelected = item._id === selectedId;
          const status = item.carePlanGenerationStatus || 'NOT_STARTED';
          const variant = status === 'COMPLETED' ? 'success' : status === 'FAILED' ? 'danger' : ['QUEUED', 'PROCESSING'].includes(status) ? 'blue' : 'warn';
          return <button type="button" className={`apex-dietitian-queue-item ${isSelected ? 'selected' : ''}`} key={item._id} onClick={() => openAssessment(item)}>
            <span className="apex-dietitian-avatar"><Utensils size={17} /></span>
            <span className="apex-dietitian-item-body"><b>{fullName(item)}</b><small>{conditionText(item)}{item.patient?.phone ? ` · ${item.patient.phone}` : ''}</small><small>{eligible ? statusLabel(status) : 'Unsupported condition for current care-plan engine'}</small></span>
            <span className={`badge ${variant}`}>{eligible ? status : 'REVIEW'}</span>
          </button>;
        })}
        {items?.length === 0 && <div className="empty-state"><CheckCircle2 size={24} /><b>No dietitian handoffs yet</b><span>When the ApexCare coordinator records a successful patient contact, that enrollment will appear here.</span></div>}
      </section>

      <section className="card glass page-enter apex-workflow-panel apex-assessment-panel">
        <div className="section-head"><div><div className="eyebrow">Assessment and generation</div><h2>{selected ? fullName(selected) : 'Select a patient'}</h2><span className="muted">The generated plan is a draft. It is not activated until clinical review and approval.</span></div><ClipboardCheck size={20} /></div>
        {!selected && <div className="empty-state"><Utensils size={24} /><b>Choose a patient from the queue</b><span>Enter the dietitian’s assessment and relevant food/lifestyle context.</span></div>}
        {selected && <>
          {submitError && <div className="alert alert-error" role="alert"><AlertCircle size={16} /> <span>{submitError}</span></div>}
          {submitMessage && <div className="apex-success-message" role="status"><CheckCircle2 size={17} /><span>{submitMessage}</span></div>}
          <div className="apex-selected-patient-summary">
            <div><span>Condition</span><b>{conditionText(selected)}</b></div>
            <div><span>Contact status</span><b>{selected.coordinatorCallStatus || 'CONTACTED'}</b></div>
            <div><span>Generation status</span><b>{statusLabel(generationStatus)}</b></div>
            {selected.patient?.phone && <div><span>Phone</span><b>{selected.patient.phone}</b></div>}
          </div>
          {!selectedEligible && <div className="apex-workflow-warning"><AlertCircle size={18} /><span>The backend currently generates care-plan drafts for confirmed hypertension only. This patient is visible for triage but cannot be submitted to the hypertension generator.</span></div>}
          {generationStatus === 'FAILED' && <div className="alert alert-error">{selected.carePlanGenerationError || 'Care-plan generation failed. The saved assessment can be retried after the underlying issue is resolved.'}</div>}
          {generationStatus === 'QUEUED' || generationStatus === 'PROCESSING' ? <div className="apex-workflow-info"><Clock3 size={18} /><span>Generation is running in the backend worker. This screen refreshes automatically while the job is queued or processing.</span></div> : null}
          {generationStatus === 'COMPLETED' && <div className="apex-success-message"><CheckCircle2 size={17} /><span>Draft generated{selected.carePlanDraftId ? ` (draft ${selected.carePlanDraftId.slice(-6)})` : ''}. It is awaiting clinician review; this is not an approved or active care plan.</span></div>}
          <div className="form-grid apex-dietitian-form">
            <label className="field field-full"><span>Dietitian assessment notes <b aria-hidden="true">*</b></span><textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={5} maxLength={5000} disabled={formReadOnly || !selectedEligible} placeholder="Record the consultation findings, barriers, relevant context and agreed nutrition recommendations." /></label>
            <label className="field field-full"><span>Typical dietary pattern</span><textarea value={dietaryPattern} onChange={(e) => setDietaryPattern(e.target.value)} rows={3} maxLength={1500} disabled={formReadOnly || !selectedEligible} placeholder="Meals, timing, staples, eating out, salt/sugar patterns and other reported habits." /></label>
            <label className="field"><span>Food preferences and restrictions</span><textarea value={foodPreferences} onChange={(e) => setFoodPreferences(e.target.value)} rows={3} maxLength={1000} disabled={formReadOnly || !selectedEligible} placeholder="Preferences, cultural foods, affordability or access constraints." /></label>
            <label className="field"><span>Food allergies or intolerances</span><textarea value={allergiesOrIntolerances} onChange={(e) => setAllergiesOrIntolerances(e.target.value)} rows={3} maxLength={1000} disabled={formReadOnly || !selectedEligible} placeholder="Record reported allergies or intolerances; do not assume none." /></label>
            <label className="field"><span>Physical activity and daily routine</span><textarea value={activityLevel} onChange={(e) => setActivityLevel(e.target.value)} rows={3} maxLength={1000} disabled={formReadOnly || !selectedEligible} placeholder="Patient-reported activity, work routine and barriers." /></label>
            <label className="field"><span>Agreed nutrition goals</span><textarea value={nutritionGoals} onChange={(e) => setNutritionGoals(e.target.value)} rows={3} maxLength={1500} disabled={formReadOnly || !selectedEligible} placeholder="Document goals agreed with the patient; the clinician will review the generated plan." /></label>
          </div>
          {selected.assessment && <p className="apex-form-note">An assessment has already been saved for this enrollment. The backend reuses it for retries, so these fields are read-only.</p>}
          <div className="apex-assessment-actions">
            {(canCreateAssessment || canRetry || canUpdateDietChart) && <button className="primary" onClick={() => void saveAssessment()} disabled={busy || !remarks.trim()}><Send size={15} /> {busy ? 'Saving…' : canUpdateDietChart ? 'Save dietitian chart' : canRetry ? 'Retry care-plan generation' : 'Save assessment'}</button>}
            {['QUEUED', 'PROCESSING'].includes(generationStatus) && <span className="muted"><RefreshCw size={14} /> Waiting for worker</span>}
            {generationStatus === 'COMPLETED' && <span className="apex-completion-label"><CheckCircle2 size={15} /> Draft sent for clinician review</span>}
          </div>
        </>}
      </section>
    </div>
  </ApexShell>;
}
