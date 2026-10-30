"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, RefreshCw, Search, UserPlus } from 'lucide-react';
import { Gate, RoleGate, Shell } from '@/components/Shell';
import { apexcareReferrals, newDiagnosisQueue } from '@/lib/api';
import type { ApexCareReferral, NewDiagnosisQueueItem } from '@/types/api';

function fmt(value?: string | null) { return value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Not recorded'; }

export default function EnrollmentPage() {
  const [items, setItems] = useState<NewDiagnosisQueueItem[] | null>(null);
  const [referrals, setReferrals] = useState<ApexCareReferral[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError('');
    try {
      const [diagnoses, referralList] = await Promise.all([newDiagnosisQueue(), apexcareReferrals()]);
      setItems(diagnoses);
      setReferrals(referralList);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load enrollment queue.'); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const referralByPatient = useMemo(() => new Map<string, ApexCareReferral>(referrals.map((referral) => [referral.patientId, referral] as const)), [referrals]);
  const filtered = (items || []).filter((item) => [item.patientName, item.medicalRecordNumber, item.condition, item.assignedClinicianName, item.enrollmentStatus].some((value) => String(value || '').toLowerCase().includes(search.trim().toLowerCase())));
  const overdueCount = (items || []).filter((item) => {
    const referral = referralByPatient.get(item.patientId);
    const dueAt = referral?.staffEscalationDueAt || item.staffEscalationDueAt;
    return Boolean(dueAt && new Date(dueAt).getTime() < Date.now()) || Boolean(referral?.staffEscalatedAt || item.staffEscalatedAt);
  }).length;

  return <Gate><RoleGate allowed={['CLINIC_COORDINATOR']}><Shell title="Enrollment worklist" subtitle="New clinician referrals that need coordinator onboarding and handoff.">
    <section className="hero glass page-enter coordinator-todo-hero"><div><div className="eyebrow">New diagnosis → enrollment</div><h2>Complete the onboarding handoff.</h2><p>Open the patient record to collect contact details, capture the prescription, record required vitals and submit enrollment. Referral SLA and escalation timestamps are shown below.</p></div><button className="secondary" onClick={() => void load(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'button-spinner' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh queue'}</button></section>
    {error && <div className="card glass alert-error section"><b>Enrollment queue unavailable.</b><p>{error}</p><button className="secondary" onClick={() => void load(true)}>Try again</button></div>}
    {!items && !error && <div className="grid g2 section">{[1,2].map((i) => <div className="card glass skeleton-stat" key={i} />)}</div>}
    {items && <>
      <section className="grid g3 section coordinator-stat-grid"><div className="card glass stat"><UserPlus size={18}/><small>Awaiting enrollment</small><strong>{items.length}</strong><span className="muted">Pending clinician referrals</span></div><div className="card glass stat"><AlertTriangle size={18}/><small>SLA due / escalated</small><strong>{overdueCount}</strong><span className="muted">Referral needs prompt attention</span></div><div className="card glass stat"><Clock3 size={18}/><small>Referral records</small><strong>{referrals.length}</strong><span className="muted">Raw pending-staff referral queue</span></div></section>
      <section className="card glass section page-enter"><div className="section-head"><div><div className="eyebrow">Staff queue</div><h2>Patients awaiting enrollment</h2><span className="muted">Sort your work by the referral escalation timing and open each patient to continue onboarding.</span></div><span className="badge blue">{filtered.length} patients</span></div>
        <label className="coordinator-search"><Search size={16}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient, MRN, condition or clinician…"/><button type="button" onClick={() => setSearch('')} disabled={!search} aria-label="Clear search">×</button></label>
        {!filtered.length && <div className="empty-state"><CheckCircle2 size={20}/><b>{items.length ? 'No matching referrals' : 'No patients waiting for enrollment'}</b><span>{items.length ? 'Try a different search term.' : 'When a clinician creates a confirmed diagnosis and referral, it will appear here.'}</span></div>}
        <div className="coordinator-enrollment-list">{filtered.map((item) => { const referral = referralByPatient.get(item.patientId); const dueAt = referral?.staffEscalationDueAt || item.staffEscalationDueAt; const escalatedAt = referral?.staffEscalatedAt || item.staffEscalatedAt; const overdue = Boolean(dueAt && new Date(dueAt).getTime() < Date.now()); const escalated = Boolean(escalatedAt); return <article className="coordinator-task-card" key={item.referralId || item.patientId}><div className={`coordinator-priority-dot ${overdue || escalated ? 'high' : 'medium'}`}/><div className="coordinator-task-content"><div className="coordinator-work-title"><Link href={`/patients/${item.patientId}`}><b>{item.patientName}</b><ArrowUpRight size={13}/></Link><span className={`badge ${overdue || escalated ? 'danger' : 'warn'}`}>{escalated ? 'Escalated' : overdue ? 'SLA overdue' : 'Awaiting staff'}</span></div><div className="coordinator-task-meta">{item.medicalRecordNumber || 'No MRN'} · {String(item.condition || 'Condition not specified').replaceAll('_', ' ')} · {String(item.enrollmentStatus || 'NOT_ENROLLED').replaceAll('_', ' ')}</div><div className="coordinator-detail-chips"><span>Diagnosed: {fmt(item.diagnosedAt)}</span><span>Referred: {fmt(referral?.referredAt || item.referredAt)}</span><span>Staff SLA: {fmt(dueAt)}</span>{escalatedAt && <span>Escalated: {fmt(escalatedAt)}</span>}<span>Clinician: {item.assignedClinicianName || 'Not recorded'}</span><span>Referral status: {String(referral?.status || 'PENDING_STAFF').replaceAll('_', ' ')}</span></div></div><div className="coordinator-task-actions"><Link className="primary compact-action" href={`/patients/${item.patientId}`}>Continue enrollment <ArrowUpRight size={13}/></Link></div></article>; })}</div>
      </section>
    </>}
  </Shell></RoleGate></Gate>;
}
