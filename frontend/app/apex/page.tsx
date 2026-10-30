'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileText,
  HeartPulse,
  PhoneCall,
  RefreshCw,
  ShieldCheck,
  Users,
  Utensils,
} from 'lucide-react';
import { Gate } from '@/components/Shell';
import { ApexRoleGate, ApexShell } from '@/components/ApexShell';
import { apexCoordinatorQueue, apexReferrals, apexServiceCases } from '@/lib/api';
import type { ApexCareEnrollment, ApexCareReferral, DietitianServiceCase } from '@/types/api';

function StatusBadge({ value, tone = 'blue' }: { value: string; tone?: 'blue' | 'success' | 'warn' | 'danger' }) {
  return <span className={`badge ${tone}`}>{value.replaceAll('_', ' ')}</span>;
}

function displayDate(value?: string | null) {
  if (!value) return 'Date not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date not recorded' : date.toLocaleDateString();
}

function patientLabel(patientId: string) {
  return `Patient · ${patientId.slice(-6).toUpperCase()}`;
}

export default function ApexDashboard() {
  return (
    <Gate fallbackPath="/apex/login">
      <ApexRoleGate allowed={['APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST', 'APEXCARE_DOCTOR', 'PLATFORM_ADMIN']}>
        <ApexHome />
      </ApexRoleGate>
    </Gate>
  );
}

function ApexHome() {
  const [role, setRole] = useState<string | null>(null);
  const [coordinator, setCoordinator] = useState<ApexCareEnrollment[] | null>(null);
  const [referrals, setReferrals] = useState<ApexCareReferral[] | null>(null);
  const [cases, setCases] = useState<DietitianServiceCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    const results = await Promise.allSettled([
      apexCoordinatorQueue(),
      apexReferrals(),
      apexServiceCases(),
    ]);
    const [queueResult, referralResult, caseResult] = results;
    if (queueResult.status === 'fulfilled') setCoordinator(queueResult.value);
    if (referralResult.status === 'fulfilled') setReferrals(referralResult.value);
    if (caseResult.status === 'fulfilled') setCases(caseResult.value);
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    if (failedCount === results.length) {
      setError('Unable to load ApexCare operations. Check your connection and try again.');
    } else if (failedCount > 0) {
      setError('Some dashboard data could not be loaded. Refresh before relying on these counts.');
    }
    setLoaded(true);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem('apexcare_user') || '{}');
      setRole(user.roles?.[0] || null);
    } catch {
      setRole(null);
    }
    void load();
  }, [load]);

  const coordinatorView = role === 'APEXCARE_COORDINATOR';
  const dietitianView = role === 'APEXCARE_DIETITIAN';
  const queueItems = coordinator || [];
  const referralItems = referrals || [];
  const serviceItems = cases || [];
  const openCases = serviceItems.filter((item) => !['COMPLETED', 'CANCELLED'].includes(item.status));

  if (!loaded) {
    return (
      <ApexShell title="ApexCare workspace" subtitle="Loading your operational queues.">
        <section className="grid g3 section apex-dashboard-stats" aria-label="Loading dashboard">
          {[1, 2, 3].map((item) => <div className="card glass skeleton-stat" key={item} />)}
        </section>
      </ApexShell>
    );
  }

  if (coordinator === null && referrals === null && cases === null && error) {
    return (
      <ApexShell title="ApexCare workspace unavailable" subtitle="The dashboard could not load any operational data.">
        <section className="card glass alert-error section apex-dashboard-error" role="alert">
          <div><b>Unable to load ApexCare operations</b><p>{error}</p></div>
          <button type="button" className="secondary" onClick={() => void load(true)} disabled={refreshing}>Retry</button>
        </section>
      </ApexShell>
    );
  }

  return (
    <ApexShell
      title={coordinatorView ? 'Coordinator workspace' : 'Good morning.'}
      subtitle={coordinatorView ? 'Move each patient from clinic handoff into a complete, doctor-led care intake.' : dietitianView ? 'Work from assigned service cases and practical nutrition care.' : 'A focused ApexCare operations workspace.'}
    >
      {error && (
        <div className="card glass alert-error section apex-dashboard-error" role="status">
          <div><b>Dashboard data warning</b><p>{error}</p></div>
          <button type="button" className="secondary" onClick={() => void load(true)} disabled={refreshing}>Retry</button>
        </div>
      )}

      <section className="hero glass page-enter workspace-hero apex-dashboard-hero">
        <div className="apex-dashboard-hero-copy">
          <div className="eyebrow">ApexCare operations · Today</div>
          <h2>{coordinatorView ? 'Start with the patient, not the contact status.' : dietitianView ? 'Focus on the next care action.' : 'Work from the patient journey.'}</h2>
          <p>{coordinatorView
            ? 'Contact is one step. The next intake stage is a guided general medical history, using Yes / No / Unknown answers and follow-up questions only when relevant.'
            : 'Use the live queues below to open the relevant workflow. Counts reflect API responses, not static targets.'}</p>
        </div>
        <div className="hero-actions apex-dashboard-hero-actions">
          <button type="button" className="secondary" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'button-spinner' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {coordinatorView && <Link className="primary" href="/apex/queue">Open coordinator queue <ArrowUpRight size={14} /></Link>}
          {dietitianView && <Link className="primary" href="/apex/dietitian">Open dietitian queue <ArrowUpRight size={14} /></Link>}
          {!coordinatorView && !dietitianView && <Link className="primary" href="/apex/services">Open service cases <ArrowUpRight size={14} /></Link>}
        </div>
      </section>

      <section className="grid g3 section apex-dashboard-stats" aria-label="ApexCare workload summary">
        <div className="card glass stat page-enter apex-dashboard-stat">
          <PhoneCall size={19} aria-hidden="true" />
          <small>{coordinatorView ? 'Coordinator queue' : 'Assigned care queue'}</small>
          <strong>{coordinatorView ? queueItems.length : openCases.length}</strong>
          <span className="muted">{coordinatorView ? 'Patient handoffs awaiting next action' : 'Open service cases'}</span>
        </div>
        <div className="card glass stat page-enter apex-dashboard-stat">
          <ClipboardList size={19} aria-hidden="true" />
          <small>Clinic referrals</small>
          <strong>{referralItems.length}</strong>
          <span className="muted">Referral records returned by the backend</span>
        </div>
        <div className="card glass stat page-enter apex-dashboard-stat">
          {dietitianView ? <Utensils size={19} aria-hidden="true" /> : <Users size={19} aria-hidden="true" />}
          <small>Open service cases</small>
          <strong>{openCases.length}</strong>
          <span className="muted">Dietitian and specialist handoffs</span>
        </div>
      </section>

      <section className="grid g2 section apex-dashboard-main-grid">
        <div className="card glass page-enter apex-dashboard-panel">
          <div className="section-head apex-dashboard-section-head">
            <div><div className="eyebrow">Next actions</div><h2>{coordinatorView ? 'Patient handoffs' : dietitianView ? 'Service work' : 'Active work'}</h2><span className="muted">Live items from the connected ApexCare queues.</span></div>
            <Activity size={20} aria-hidden="true" />
          </div>

          {coordinatorView ? queueItems.slice(0, 5).map((item) => (
            <article className="apex-dashboard-list-row" key={item._id}>
              <div className="apex-dashboard-row-icon"><PhoneCall size={16} aria-hidden="true" /></div>
              <div className="apex-dashboard-row-content">
                <b>{patientLabel(item.patientId)}</b>
                <span>Call status: {(item.coordinatorCallStatus || 'PENDING').replaceAll('_', ' ')}</span>
                <small>Due: {displayDate(item.coordinatorCallDueAt)}</small>
              </div>
              <Link className="secondary compact-action" href="/apex/queue">Open <ArrowUpRight size={13} /></Link>
            </article>
          )) : serviceItems.slice(0, 5).map((item) => (
            <article className="apex-dashboard-list-row" key={item._id}>
              <div className="apex-dashboard-row-icon"><HeartPulse size={16} aria-hidden="true" /></div>
              <div className="apex-dashboard-row-content">
                <b>{patientLabel(item.patientId)}</b>
                <span>{item.service.replaceAll('_', ' ')} · {item.status.replaceAll('_', ' ')}</span>
                <small>{item.reason || 'No handoff reason recorded.'}</small>
              </div>
              <Link className="secondary compact-action" href={dietitianView ? '/apex/dietitian' : '/apex/services'}>Open <ArrowUpRight size={13} /></Link>
            </article>
          ))}

          {((coordinatorView && queueItems.length === 0) || (!coordinatorView && serviceItems.length === 0)) && (
            <div className="empty-state compact">
              <CheckCircle2 size={22} />
              <b>No immediate work</b>
              <span>New handoffs will appear here when the backend returns them.</span>
            </div>
          )}
          <Link className="secondary full-action" href={coordinatorView ? '/apex/queue' : dietitianView ? '/apex/dietitian' : '/apex/services'}>
            View full queue <ArrowUpRight size={14} />
          </Link>
        </div>

        {coordinatorView ? (
          <div className="card glass page-enter apex-dashboard-panel">
            <div className="section-head apex-dashboard-section-head">
              <div><div className="eyebrow">Next intake step</div><h2>General medical history</h2><span className="muted">Doctor-led baseline intake · medication history stays separate.</span></div>
              <FileText size={20} aria-hidden="true" />
            </div>
            <div className="apex-history-steps">
              <div className="apex-history-step"><span>1</span><div><b>Ask a clear Yes / No question</b><small>Allow Unknown or Declined when the patient cannot or does not wish to answer.</small></div></div>
              <div className="apex-history-step"><span>2</span><div><b>Show conditional follow-ups</b><small>If symptoms are present, collect duration, onset, severity and associated symptoms.</small></div></div>
              <div className="apex-history-step"><span>3</span><div><b>Record a trustworthy baseline</b><small>Cover past medical, family, social, allergy, relevant reproductive and prior investigation history.</small></div></div>
            </div>
            <div className="apex-history-note"><ShieldCheck size={17} aria-hidden="true" /><p>History status and save actions are not wired yet: the current API supports call outcomes only. This panel is the dashboard preparation, not a claim that history has been collected.</p></div>
            <Link className="secondary full-action" href="/apex/queue">Continue with patient handoffs <ArrowUpRight size={14} /></Link>
          </div>
        ) : (
          <div className="card glass page-enter apex-dashboard-panel">
            <div className="section-head apex-dashboard-section-head">
              <div><div className="eyebrow">Handoff status</div><h2>Referral pipeline</h2><span className="muted">Recent clinic referrals and escalation status.</span></div>
              <ClipboardList size={20} aria-hidden="true" />
            </div>
            {referralItems.slice(0, 5).map((referral) => (
              <article className="apex-dashboard-list-row" key={referral._id}>
                <div className="apex-dashboard-row-icon"><ClipboardList size={16} aria-hidden="true" /></div>
                <div className="apex-dashboard-row-content">
                  <b>{patientLabel(referral.patientId)}</b>
                  <span>{referral.condition || 'Chronic-care referral'}</span>
                  <small>Referred: {displayDate(referral.referredAt)}</small>
                </div>
                <StatusBadge value={referral.staffEscalatedAt ? 'ESCALATED' : (referral.status || 'PENDING')} tone={referral.staffEscalatedAt ? 'danger' : 'blue'} />
              </article>
            ))}
            {!referralItems.length && <div className="empty-state compact"><CheckCircle2 size={22} /><b>No new clinic referrals</b></div>}
            <Link className="secondary full-action" href="/apex/queue">Review handoffs <ArrowUpRight size={14} /></Link>
          </div>
        )}
      </section>

      <section className="card glass section page-enter apex-dashboard-panel">
        <div className="section-head apex-dashboard-section-head">
          <div><div className="eyebrow">Operational snapshot</div><h2>Service and referral queues</h2><span className="muted">Use these links to open the workflow; this summary does not change any status.</span></div>
          <CalendarClock size={20} aria-hidden="true" />
        </div>
        <div className="apex-dashboard-queue-grid">
          <Link className="apex-dashboard-queue-link" href="/apex/queue"><span><PhoneCall size={16} /> Coordinator calls due</span><b>{queueItems.length}</b></Link>
          <Link className="apex-dashboard-queue-link" href="/apex/queue"><span><ClipboardList size={16} /> Clinic referrals</span><b>{referralItems.length}</b></Link>
          <Link className="apex-dashboard-queue-link" href="/apex/services"><span><Users size={16} /> Open service cases</span><b>{openCases.length}</b></Link>
          <Link className="apex-dashboard-queue-link" href="/apex/queue"><span><Clock3 size={16} /> Pending call outcomes</span><b>{queueItems.filter((item) => !item.coordinatorCallStatus || item.coordinatorCallStatus === 'PENDING').length}</b></Link>
        </div>
      </section>
    </ApexShell>
  );
}
