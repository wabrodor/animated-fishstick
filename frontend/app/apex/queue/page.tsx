'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, PhoneCall, RefreshCw } from 'lucide-react';
import { ApexRoleGate, ApexShell } from '@/components/ApexShell';
import { Gate } from '@/components/Shell';
import { apexCoordinatorQueue, updateCoordinatorCall } from '@/lib/api';
import type { ApexCareEnrollment } from '@/types/api';

export default function ApexQueue() {
  return <Gate fallbackPath="/apex/login"><ApexRoleGate allowed={['APEXCARE_COORDINATOR']}><QueueContent /></ApexRoleGate></Gate>;
}

function patientName(item: ApexCareEnrollment) {
  const name = item.patient?.name;
  if (!name) return `Patient ${item.patientId.slice(-6)}`;
  return [name.first, name.last].filter(Boolean).join(' ');
}

function conditionLabel(item: ApexCareEnrollment) {
  const conditions = item.patient?.conditions?.filter((condition) => condition.status !== 'INACTIVE') ?? [];
  if (!conditions.length) return 'Condition not recorded';
  return [...new Set(conditions.map((condition) => condition.code.replaceAll('_', ' ')))].join(' · ');
}

function QueueContent() {
  const [items, setItems] = useState<ApexCareEnrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apexCoordinatorQueue()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to load coordinator queue.'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function contact(item: ApexCareEnrollment, status: 'CONTACTED' | 'NO_ANSWER') {
    setBusy(item._id);
    setError(null);
    setMessage(null);
    try {
      await updateCoordinatorCall(item._id, status);
      if (status === 'CONTACTED') {
        // The backend moves CONTACTED enrollments to /apexcare/dietitian-queue.
        setItems((current) => current?.filter((candidate) => candidate._id !== item._id) ?? []);
        setMessage(`${patientName(item)} was moved to the dietitian queue. The dietitian must complete an assessment before care-plan generation starts.`);
      } else {
        setItems((current) => current?.map((candidate) => candidate._id === item._id
          ? { ...candidate, coordinatorCallStatus: 'NO_ANSWER', coordinatorCalledAt: new Date().toISOString() }
          : candidate) ?? []);
        setMessage(`No answer recorded for ${patientName(item)}. The patient remains in your queue for another contact attempt.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update contact status.');
    } finally {
      setBusy(null);
    }
  }

  return <ApexShell title="Coordinator queue" subtitle="Call newly enrolled patients, explain the 90-day service and free dietitian consultation, then hand contacted patients to the dietitian work queue.">
    <section className="card glass page-enter apex-workflow-panel">
      <div className="section-head">
        <div><div className="eyebrow">Patient outreach</div><h2>{items?.length ?? '…'} calls need attention</h2><span className="muted">A successful contact moves the enrollment to the dietitian queue. A care-plan draft is generated only after the dietitian submits an assessment.</span></div>
        <button className="secondary compact-action" onClick={() => void load()} disabled={busy !== null}><RefreshCw size={14} /> Refresh</button>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {message && <div className="apex-success-message" role="status"><CheckCircle2 size={17} /><span>{message}</span></div>}
      {items === null && !error && <div className="empty-state"><RefreshCw size={22} /><b>Loading coordinator queue</b><span>Retrieving active ApexCare enrollments.</span></div>}
      {items?.map((item) => <article className="apex-patient-work-card" key={item._id}>
        <div className="apex-patient-work-icon"><PhoneCall size={19} /></div>
        <div className="apex-patient-work-main">
          <div className="apex-patient-work-title"><h3>{patientName(item)}</h3><span className={`badge ${item.coordinatorCallStatus === 'NO_ANSWER' ? 'warn' : item.coordinatorCallStatus === 'ESCALATED' ? 'danger' : 'blue'}`}>{String(item.coordinatorCallStatus || 'PENDING').replaceAll('_', ' ')}</span></div>
          <p>{conditionLabel(item)}</p>
          <div className="apex-patient-work-meta">
            <span><Clock3 size={13} /> Due {item.coordinatorCallDueAt ? new Date(item.coordinatorCallDueAt).toLocaleString() : 'as soon as practical'}</span>
            {item.patient?.phone && <a href={`tel:${item.patient.phone}`}><PhoneCall size={13} /> {item.patient.phone}</a>}
            {item.patient?.preferredLanguage && <span>Language: {item.patient.preferredLanguage}</span>}
          </div>
          <p className="apex-work-guidance">Explain the service, confirm that the patient understands the coordinator follow-up and free dietitian consultation, and record the actual call outcome.</p>
        </div>
        <div className="apex-patient-work-actions">
          <button className="secondary" disabled={busy === item._id} onClick={() => void contact(item, 'NO_ANSWER')}>No answer</button>
          <button className="primary" disabled={busy === item._id} onClick={() => void contact(item, 'CONTACTED')}>{busy === item._id ? 'Saving…' : <>Contacted <ArrowRight size={14} /></>}</button>
        </div>
      </article>)}
      {items?.length === 0 && <div className="empty-state"><CheckCircle2 size={24} /><b>Coordinator queue is clear</b><span>New clinic enrollments will appear here. Patients marked Contacted move to the dietitian queue.</span></div>}
    </section>
  </ApexShell>;
}
