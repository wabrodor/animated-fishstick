'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FlaskConical,
  HeartPulse,
  ShieldCheck,
  Users,
  UserPlus,
  WalletCards,
  RefreshCw,
} from 'lucide-react';
import { Gate, RoleGate, Shell } from '@/components/Shell';
import {
  clinicTeam,
  apexcareReferrals,
  coordinatorEscalations,
  clinicalReviewQueue,
  clinicalSignals,
  newDiagnosisQueue,
  patients,
  queue,
  serviceCases,
  coordinatorReviews,
  subscription,
} from '@/lib/api';
import type {
  CareQueue,
  ClinicalReviewCase,
  ClinicalSignal,
  ClinicTeamMember,
  NewDiagnosisQueueItem,
  Patient,
  ServiceCase,
  CoordinatorReview,
  CoordinatorEscalation,
  ApexCareReferral,
  SubscriptionSummary,
} from '@/types/api';

function Badge({ value, tone = 'blue' }: { value?: string | number; tone?: 'blue' | 'success' | 'warn' | 'danger' }) {
  return <span className={`badge ${tone}`}>{String(value ?? '').replaceAll('_', ' ')}</span>;
}

function Stat({ icon: Icon, label, value, tone = 'blue', detail }: { icon: typeof Users; label: string; value: string | number; tone?: string; detail?: string }) {
  return (
    <div className="card glass stat page-enter">
      <Icon size={19} />
      <small>{label}</small>
      <strong>{value}</strong>
      {detail && <span className="muted">{detail}</span>}
    </div>
  );
}

function ClinicAdminDashboard() {
  const [data, setData] = useState<{ patients: Patient[]; subscription: SubscriptionSummary; team: ClinicTeamMember[]; queue: CareQueue } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([patients(), subscription(), clinicTeam(), queue()])
      .then(([patientList, sub, team, careQueue]) => setData({ patients: patientList, subscription: sub, team, queue: careQueue }))
      .catch((e) => setError(e instanceof Error ? e.message : 'Unable to load clinic overview.'));
  }, []);

  if (error) return <div className="card glass alert-error page-enter"><b>Clinic overview unavailable.</b><p>{error}</p></div>;
  if (!data) return <DashboardSkeleton />;

  const utilization = data.subscription.activePatientLimit
    ? Math.round((data.subscription.activePatientCount / data.subscription.activePatientLimit) * 100)
    : 0;
  const openWork = data.queue.counts.overdueVisits + data.queue.counts.incompleteLabs + data.queue.counts.missedCareTasks;
  const planningPatientValue = data.subscription.activePatientCount * 100;

  return (
    <>
      <section className="hero glass page-enter workspace-hero">
        <div>
          <div className="eyebrow">Clinic operations</div>
          <h2>Run the clinic without stepping into the clinical inbox.</h2>
          <p>Patient volume, team workload, care operations and subscription capacity are visible here. Clinical reasoning stays with the clinician workspace.</p>
        </div>
        <div className="hero-actions">
          <Link className="primary" href="/patients">View patients <ArrowUpRight size={14} /></Link>
          <Link className="secondary" href="/team">Manage team</Link>
        </div>
      </section>

      <section className="grid g4 section">
        <Stat icon={Users} label="Active patients" value={data.subscription.activePatientCount} detail={`${data.subscription.availablePatientSlots} slots available`} />
        <Stat icon={Activity} label="Capacity used" value={`${utilization}%`} detail={`Limit ${data.subscription.activePatientLimit}`} />
        <Stat icon={ClipboardList} label="Open operations" value={openWork} tone="warn" detail="Visits, labs and tasks" />
        <Stat icon={ShieldCheck} label="Team members" value={data.team.length} detail={`${data.team.filter((x) => x.status === 'ACTIVE').length} active`} />
      </section>

      <section className="grid g2 section">
        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Live workload snapshot</div><h2>Operational workload</h2><span className="muted">Current open counts from the care queue, not historical trends.</span></div><Activity size={20} /></div>
          <div className="admin-chart-bars">
            {[
              { label: 'Overdue visits', value: data.queue.counts.overdueVisits },
              { label: 'Incomplete labs', value: data.queue.counts.incompleteLabs },
              { label: 'Missed care tasks', value: data.queue.counts.missedCareTasks },
              { label: 'Pending reviews', value: data.queue.counts.pendingReviews },
            ].map((item) => {
              const maxValue = Math.max(1, data.queue.counts.overdueVisits, data.queue.counts.incompleteLabs, data.queue.counts.missedCareTasks, data.queue.counts.pendingReviews);
              return <div className="admin-chart-row" key={item.label}><div className="admin-chart-label"><span>{item.label}</span><b>{item.value}</b></div><div className="admin-chart-track"><div className="admin-chart-fill" style={{ width: `${Math.max(item.value > 0 ? 4 : 0, (item.value / maxValue) * 100)}%` }} /></div></div>;
            })}
          </div>
          <Link className="secondary full-action" href="/operations">Open operations overview <ArrowUpRight size={14} /></Link>
        </div>
        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Capacity</div><h2>Patient capacity</h2><span className="muted">Current subscription utilization.</span></div><Users size={20} /></div>
          <div className="capacity-chart"><div className="capacity-chart-ring" style={{ background: `conic-gradient(var(--accent, #4b7c9d) ${Math.min(100, Math.max(0, utilization))}%, rgba(120,140,155,.16) 0)` }}><div><strong>{utilization}%</strong><span>used</span></div></div><div className="capacity-chart-legend"><div><span className="legend-dot used" />Active patients <b>{data.subscription.activePatientCount}</b></div><div><span className="legend-dot available" />Available slots <b>{data.subscription.availablePatientSlots}</b></div><div><span className="legend-dot limit" />Patient limit <b>{data.subscription.activePatientLimit}</b></div></div></div>
        </div>
      </section>

      <section className="grid g2 section">
        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Financial planning</div><h2>Patient revenue projection</h2><span className="muted">Planning estimate only; not an accounting ledger.</span></div><WalletCards size={20} /></div>
          <div className="revenue-card">
            <span>Current patient-linked planning value</span>
            <strong>₹{planningPatientValue.toLocaleString('en-IN')}</strong>
            <small>Based on the current V1 planning assumption of ₹100 per active patient. Change this centrally when commercial pricing is finalized.</small>
          </div>
          <div className="mini-grid">
            <div><small>Subscription</small><b>{data.subscription.planCode}</b></div>
            <div><small>Status</small><Badge value={data.subscription.status} tone={data.subscription.status === 'ACTIVE' ? 'success' : 'warn'} /></div>
            <div><small>Period ends</small><b>{data.subscription.currentPeriodEnd ? new Date(data.subscription.currentPeriodEnd).toLocaleDateString() : '—'}</b></div>
          </div>
        </div>

        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Clinic health</div><h2>Operational pulse</h2></div><HeartPulse size={20} /></div>
          <div className="pulse-list">
            <div><span>Overdue visits</span><Badge value={data.queue.counts.overdueVisits} tone={data.queue.counts.overdueVisits ? 'danger' : 'success'} /></div>
            <div><span>Incomplete labs</span><Badge value={data.queue.counts.incompleteLabs} tone={data.queue.counts.incompleteLabs ? 'warn' : 'success'} /></div>
            <div><span>Missed care tasks</span><Badge value={data.queue.counts.missedCareTasks} tone={data.queue.counts.missedCareTasks ? 'warn' : 'success'} /></div>
          </div>
          <Link className="secondary full-action" href="/care-queue">Open operational queue <ArrowUpRight size={14} /></Link>
        </div>
      </section>

      <section className="card glass section page-enter">
        <div className="section-head"><div><div className="eyebrow">Care team</div><h2>Team at a glance</h2></div><Link className="muted" href="/team">Manage <ArrowUpRight size={13} /></Link></div>
        <div className="team-grid">
          {data.team.slice(0, 6).map((member) => (
            <div className="team-card" key={member._id}>
              <div className="avatar">{member.name.slice(0, 1).toUpperCase()}</div>
              <div><b>{member.name}</b><span>{member.roles[0]?.replaceAll('_', ' ')}</span></div>
              <Badge value={member.status} tone={member.status === 'ACTIVE' ? 'success' : 'danger'} />
            </div>
          ))}
          {!data.team.length && <div className="empty-state compact"><Users size={18} /><b>No care team members yet</b></div>}
        </div>
      </section>
    </>
  );
}

function ClinicalDashboard() {
  const [data, setData] = useState<{ patients: Patient[]; signals: ClinicalSignal[]; reviews: ClinicalReviewCase[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'URGENT' | 'SIGNALS' | 'MEDICATION' | 'CARE_PLANS'>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  async function loadWorkspace() {
    setRefreshing(true);
    setError(null);
    try {
      const [patientList, signalList, reviewList] = await Promise.all([
        patients(),
        clinicalSignals(),
        clinicalReviewQueue(),
      ]);
      setData({ patients: patientList, signals: signalList, reviews: reviewList });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load clinical worklist.');
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadWorkspace();
  }, []);

  if (error && !data) return <div className="card glass alert-error page-enter"><b>Clinical worklist unavailable.</b><p>{error}</p><button className="secondary" onClick={() => void loadWorkspace()}>Try again</button></div>;
  if (!data) return <DashboardSkeleton />;

  type WorklistTask = {
    id: string;
    category: 'SIGNALS' | 'MEDICATION' | 'CARE_PLANS';
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    description: string;
    patientId: string;
    patientName: string;
    mrn?: string;
    href: string;
    dueAt?: string;
    createdAt?: string;
  };

  const patientById = new Map<string, Patient>(
    data.patients.map((patient) => [patient._id, patient] as const),
  );
  const openSignals = data.signals.filter((signal) => signal.status === 'OPEN' || signal.status === 'ACTION_REQUIRED');
  const tasks: WorklistTask[] = [
    ...openSignals.map((signal) => {
      const patient = patientById.get(signal.patientId);
      return {
        id: `signal-${signal._id}`,
        category: 'SIGNALS' as const,
        priority: signal.priority,
        title: signal.kind.replaceAll('_', ' '),
        description: signal.summary,
        patientId: signal.patientId,
        patientName: patient ? `${patient.name.first} ${patient.name.last || ''}`.trim() : `Patient ${signal.patientId.slice(-6)}`,
        mrn: patient?.medicalRecordNumber,
        href: `/patients/${signal.patientId}`,
        createdAt: signal.createdAt,
      };
    }),
    ...data.reviews.map((review) => {
      const patient = patientById.get(review.patientId);
      const dueDate = review.clinicReviewDueAt ? new Date(review.clinicReviewDueAt) : null;
      const overdue = !!dueDate && !Number.isNaN(dueDate.getTime()) && dueDate.getTime() < Date.now();
      return {
        id: `medication-${review._id}`,
        category: 'MEDICATION' as const,
        priority: overdue ? 'HIGH' as const : 'MEDIUM' as const,
        title: 'Verify medication / prescription',
        description: review.reason || review.reasonCode?.replaceAll('_', ' ') || 'Prescription analysis requires a clinician decision.',
        patientId: review.patientId,
        patientName: patient ? `${patient.name.first} ${patient.name.last || ''}`.trim() : `Patient ${review.patientId.slice(-6)}`,
        mrn: patient?.medicalRecordNumber,
        href: '/clinical-inbox',
        dueAt: review.clinicReviewDueAt,
        createdAt: review.createdAt,
      };
    }),
    ...data.patients
      .filter((patient) => patient.enrollmentStatus === 'CARE_PLAN_REVIEW')
      .map((patient) => ({
        id: `care-plan-${patient._id}`,
        category: 'CARE_PLANS' as const,
        priority: 'MEDIUM' as const,
        title: 'Review care plan',
        description: 'This patient is awaiting care-plan review.',
        patientId: patient._id,
        patientName: `${patient.name.first} ${patient.name.last || ''}`.trim(),
        mrn: patient.medicalRecordNumber,
        href: `/patients/${patient._id}`,
      })),
  ];

  const priorityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  tasks.sort((a, b) => {
    const priorityDifference = priorityRank[a.priority] - priorityRank[b.priority];
    if (priorityDifference !== 0) return priorityDifference;
    const aDate = a.dueAt || a.createdAt;
    const bDate = b.dueAt || b.createdAt;
    if (aDate && bDate) return new Date(aDate).getTime() - new Date(bDate).getTime();
    if (aDate) return -1;
    if (bDate) return 1;
    return 0;
  });

  const visibleTasks = tasks.filter((task) => {
    if (filter === 'URGENT') return task.priority === 'HIGH';
    if (filter === 'SIGNALS') return task.category === 'SIGNALS';
    if (filter === 'MEDICATION') return task.category === 'MEDICATION';
    if (filter === 'CARE_PLANS') return task.category === 'CARE_PLANS';
    return true;
  });
  const urgentCount = tasks.filter((task) => task.priority === 'HIGH').length;
  const medicationCount = tasks.filter((task) => task.category === 'MEDICATION').length;
  const carePlanCount = tasks.filter((task) => task.category === 'CARE_PLANS').length;

  const categoryLabel = (category: WorklistTask['category']) =>
    category === 'SIGNALS' ? 'Clinical signal' : category === 'MEDICATION' ? 'Medication review' : 'Care plan';
  const priorityTone = (priority: WorklistTask['priority']): 'danger' | 'warn' | 'blue' =>
    priority === 'HIGH' ? 'danger' : priority === 'MEDIUM' ? 'warn' : 'blue';

  return (
    <>
      <section className="hero glass page-enter workspace-hero">
        <div>
          <div className="eyebrow">Your clinical worklist</div>
          <h2>What needs your clinical attention today?</h2>
          <p>Start with high-priority exceptions, then work through medication verification and care-plan reviews. Operational follow-up remains with the coordinator.</p>
        </div>
        <button className="secondary" onClick={() => void loadWorkspace()} disabled={refreshing}>
          <Activity size={14} /> {refreshing ? 'Refreshing…' : 'Refresh tasks'}
        </button>
      </section>

      {error && <div className="card glass alert-error section"><b>Some worklist data could not be refreshed.</b><p>{error}</p></div>}

      <section className="grid g3 section clinical-stats-row">
        <div className="card glass stat page-enter">
          <ClipboardList size={19} />
          <small>Tasks needing action</small>
          <strong>{tasks.length}</strong>
          <span className="muted">Across your clinical worklist</span>
        </div>
        <div className="card glass stat page-enter">
          <AlertTriangle size={19} />
          <small>High priority</small>
          <strong>{urgentCount}</strong>
          <span className="muted">Review promptly</span>
        </div>
        <div className="card glass stat page-enter">
          <ShieldCheck size={19} />
          <small>Medication reviews</small>
          <strong>{medicationCount}</strong>
          <span className="muted">{carePlanCount} care plans also awaiting review</span>
        </div>
      </section>

      <section className="card glass section page-enter">
        <div className="section-head">
          <div>
            <div className="eyebrow">Prioritized tasks</div>
            <h2>My tasks <span className="muted">({visibleTasks.length})</span></h2>
            <span className="muted">Sorted by priority, then due date where available.</span>
          </div>
          <ClipboardList size={20} />
        </div>

        <div className="task-filter-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0' }}>
          {([
            ['ALL', 'All tasks'],
            ['URGENT', 'Urgent'],
            ['SIGNALS', 'Clinical signals'],
            ['MEDICATION', 'Medication'],
            ['CARE_PLANS', 'Care plans'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'primary' : 'secondary'}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              {label}
            </button>
          ))}
        </div>

        {visibleTasks.length ? (
          <div className="clinician-task-list" style={{ display: 'grid', gap: 12 }}>
            {visibleTasks.map((task) => (
              <article
                className="signal-list-row"
                key={task.id}
                style={{ alignItems: 'flex-start', padding: 16, border: '1px solid var(--border, rgba(127,127,127,.2))', borderRadius: 14, gap: 14 }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <Badge value={task.priority} tone={priorityTone(task.priority)} />
                    <Badge value={categoryLabel(task.category)} />
                    {task.dueAt && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        Due {new Date(task.dueAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <b style={{ display: 'block', textTransform: 'capitalize' }}>{task.title.toLowerCase()}</b>
                  <div className="muted" style={{ marginTop: 4 }}>{task.patientName}{task.mrn ? ` · ${task.mrn}` : ''}</div>
                  <p style={{ margin: '8px 0 0' }}>{task.description}</p>
                </div>
                <Link className="secondary" href={task.href} style={{ flexShrink: 0 }}>
                  Review <ArrowUpRight size={14} />
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact">
            <CheckCircle2 size={24} />
            <b>{filter === 'ALL' ? 'Your clinical worklist is clear' : 'No tasks in this category'}</b>
            <span>{filter === 'ALL' ? 'There are no open clinical signals, medication reviews, or care plans awaiting review.' : 'Try another filter to see other outstanding work.'}</span>
          </div>
        )}
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          Tasks open their existing patient or clinical inbox workflow. Completion is recorded only through the relevant clinical action; this list does not mark work complete by checkbox.
        </p>
      </section>
    </>
  );
}

function StaffDashboard() {
  const [data, setData] = useState<{
    queue: CareQueue;
    diagnoses: NewDiagnosisQueueItem[];
    cases: ServiceCase[];
    reviews: CoordinatorReview[];
    escalations: CoordinatorEscalation[];
    referrals: ApexCareReferral[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      const [careQueue, diagnoses, cases, reviews, escalations, referrals] = await Promise.all([
        queue(), newDiagnosisQueue(), serviceCases(), coordinatorReviews(), coordinatorEscalations(), apexcareReferrals(),
      ]);
      setData({ queue: careQueue, diagnoses, cases, reviews, escalations, referrals });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load coordinator worklist.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error && !data) return <div className="card glass alert-error page-enter"><b>Coordinator worklist unavailable.</b><p>{error}</p><button className="secondary" onClick={() => void load(true)}>Try again</button></div>;
  if (!data) return <DashboardSkeleton />;

  const referralByPatient = new Map<string, ApexCareReferral>(data.referrals.map((referral) => [referral.patientId, referral] as const));
  const overdueTaskCount = data.queue.tasks.filter((task) => task.status === 'OVERDUE' || task.status === 'SKIPPED').length;
  const needsAction = data.queue.tasks.length + data.reviews.length + data.diagnoses.length + data.escalations.length + data.cases.length;
  const highReviews = data.reviews.filter((review) => review.priority === 'HIGH').length;
  const highTasks = data.queue.tasks.filter((task) => task.priority === 'HIGH').length;
  const highEnrollment = data.diagnoses.filter((item) => {
    const referral = referralByPatient.get(item.patientId);
    const due = referral?.staffEscalationDueAt || item.staffEscalationDueAt;
    return Boolean(due && new Date(due).getTime() < Date.now()) || Boolean(referral?.staffEscalatedAt || item.staffEscalatedAt);
  }).length;
  const priorityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const topTasks = [
    ...data.queue.tasks.map((task) => ({ id: `task-${task._id}`, priority: task.priority, title: task.title || task.type.replaceAll('_', ' '), patient: `${task.patient.name.first} ${task.patient.name.last || ''}`.trim(), detail: `${task.patient.medicalRecordNumber || 'No MRN'} · ${task.type.replaceAll('_', ' ')} · ${task.status.replaceAll('_', ' ')}`, href: `/patients/${task.patient._id}`, dueAt: task.dueAt, kind: 'Operational task' })),
    ...data.reviews.map((review) => ({ id: `review-${review._id}`, priority: review.priority, title: `Day ${review.milestone.day} patient review`, patient: review.patient.name, detail: `${review.patient.medicalRecordNumber || 'No MRN'} · ${review.contactStatus.replaceAll('_', ' ')}`, href: `/reviews?reviewId=${encodeURIComponent(review._id)}`, dueAt: review.dueAt, kind: 'Patient review' })),
    ...data.diagnoses.map((item) => {
      const referral = referralByPatient.get(item.patientId);
      const dueAt = referral?.staffEscalationDueAt || item.staffEscalationDueAt;
      const overdue = Boolean(dueAt && new Date(dueAt).getTime() < Date.now()) || Boolean(referral?.staffEscalatedAt || item.staffEscalatedAt);
      return { id: `enrollment-${item.referralId || item.patientId}`, priority: overdue ? 'HIGH' as const : 'MEDIUM' as const, title: 'Complete new-patient enrollment', patient: item.patientName, detail: `${item.medicalRecordNumber || 'No MRN'} · ${(item.condition || 'New diagnosis').replaceAll('_', ' ')} · ${item.assignedClinicianName || 'Clinician not listed'}`, href: `/patients/${item.patientId}`, dueAt, kind: 'Enrollment' };
    }),
    ...data.escalations.map((item) => ({ id: `escalation-${item._id}`, priority: 'HIGH' as const, title: (item.escalationType || 'Coordinator escalation').replaceAll('_', ' '), patient: item.patientId ? `Patient ${item.patientId.slice(-6)}` : 'Patient follow-up', detail: item.reason || 'System-generated follow-up required', href: item.patientId ? `/patients/${item.patientId}` : '/care-queue', dueAt: item.createdAt, kind: 'Escalation' })),
  ].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || (a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY) - (b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY));

  const fmt = (value?: string | null) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Not recorded';

  return (
    <>
      <section className="hero glass page-enter workspace-hero coordinator-todo-hero">
        <div><div className="eyebrow">Coordinator worklist · Today</div><h2>Work from the most urgent patient task down.</h2><p>Enroll new referrals, contact patients, complete permitted follow-ups and route clinical questions to the clinician. The backend remains the source of truth for task status.</p></div>
        <div className="hero-actions"><button className="secondary" onClick={() => void load(true)} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'button-spinner' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh worklist'}</button><Link className="primary" href="/care-queue">Open full task list <ArrowUpRight size={14} /></Link></div>
      </section>

      {error && <div className="card glass alert-error section"><b>Some worklist data could not be refreshed.</b><p>{error}</p></div>}

      <section className="grid g4 section coordinator-stat-grid">
        <Stat icon={ClipboardList} label="Open work items" value={needsAction} detail="Tasks, reviews, enrollment, escalations and service requests" />
        <Stat icon={AlertTriangle} label="Act now" value={highTasks + highReviews + highEnrollment + data.escalations.length} tone="danger" detail={`${overdueTaskCount} overdue / skipped operational tasks`} />
        <Stat icon={UserPlus} label="New enrollments" value={data.diagnoses.length} detail={`${highEnrollment} at or beyond referral escalation threshold`} />
        <Stat icon={CheckCircle2} label="Patient reviews" value={data.reviews.length} detail={`${highReviews} high priority · ${data.queue.counts.pendingReviews} backend pending-review count`} />
      </section>

      <section className="grid g2 section coordinator-overview-grid">
        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Next actions</div><h2>Priority worklist</h2><span className="muted">Sorted by priority, then due time when available.</span></div><ClipboardList size={20} /></div>
          {topTasks.slice(0, 7).map((item) => <div className="coordinator-work-row" key={item.id}><div className={`coordinator-priority-dot ${item.priority.toLowerCase()}`} /><div className="coordinator-work-main"><div className="coordinator-work-title"><b>{item.title}</b><span className={`priority ${item.priority.toLowerCase()}`}>{item.priority}</span></div><span className="muted">{item.patient} · {item.kind}</span><small>{item.detail}</small><small className="muted">Due / event: {fmt(item.dueAt)}</small></div><Link className="secondary compact-action" href={item.href}>Open <ArrowUpRight size={13} /></Link></div>)}
          {!topTasks.length && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No urgent operational work</b><span>Review enrollment, service requests and upcoming tasks in the full worklist.</span></div>}
          <Link className="secondary full-action" href="/care-queue">View all work items <ArrowUpRight size={14} /></Link>
        </div>

        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Operational snapshot</div><h2>Care queue counts</h2><span className="muted">Counts supplied by the backend care-queue endpoint.</span></div><Activity size={20} /></div>
          <div className="coordinator-count-list">
            <Link href="/care-queue?filter=URGENT"><span><AlertTriangle size={16} /> Overdue visits</span><b>{data.queue.counts.overdueVisits}</b></Link>
            <Link href="/care-queue?filter=CARE_TASKS"><span><FlaskConical size={16} /> Incomplete labs</span><b>{data.queue.counts.incompleteLabs}</b></Link>
            <Link href="/care-queue?filter=CARE_TASKS"><span><Clock3 size={16} /> Missed care tasks</span><b>{data.queue.counts.missedCareTasks}</b></Link>
            <Link href="/care-queue?filter=REVIEWS"><span><ClipboardList size={16} /> Pending reviews</span><b>{data.queue.counts.pendingReviews}</b></Link>
          </div>
          <div className="coordinator-secondary-counts"><div><span>Open escalations</span><b>{data.escalations.length}</b></div><div><span>Service requests</span><b>{data.cases.length}</b></div><div><span>Referral queue</span><b>{data.referrals.length}</b></div></div>
          <Link className="secondary full-action" href="/care-queue">Manage operational tasks <ArrowUpRight size={14} /></Link>
        </div>
      </section>

      <section className="grid g2 section coordinator-overview-grid">
        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">Enrollment handoff</div><h2>New diagnoses waiting</h2><span className="muted">Contact the patient, collect enrollment details and required records.</span></div><span className="badge blue">{data.diagnoses.length}</span></div>
          {data.diagnoses.slice(0, 5).map((item) => {
            const referral = referralByPatient.get(item.patientId);
            const dueAt = referral?.staffEscalationDueAt || item.staffEscalationDueAt;
            const escalatedAt = referral?.staffEscalatedAt || item.staffEscalatedAt;
            return <div className="coordinator-mini-row" key={item.referralId || item.patientId}><div><b>{item.patientName}</b><span>{item.medicalRecordNumber || 'No MRN'} · {(item.condition || 'Condition not specified').replaceAll('_', ' ')}</span><small>Clinician: {item.assignedClinicianName || 'Not assigned'} · Diagnosed: {fmt(item.diagnosedAt)}</small><small>Referred: {fmt(referral?.referredAt || item.referredAt)} · Staff SLA: {fmt(dueAt)}</small>{escalatedAt && <span className="badge danger">Escalated {fmt(escalatedAt)}</span>}</div><Link className="secondary compact-action" href={`/patients/${item.patientId}`}>Enroll <ArrowUpRight size={13} /></Link></div>;
          })}
          {!data.diagnoses.length && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No new referrals waiting</b></div>}
          <Link className="secondary full-action" href="/enrollment">Open enrollment queue <ArrowUpRight size={14} /></Link>
        </div>

        <div className="card glass page-enter">
          <div className="section-head"><div><div className="eyebrow">ApexCare handoff</div><h2>Service requests</h2><span className="muted">Dietitian and specialist requests raised by clinicians.</span></div><span className="badge blue">{data.cases.length}</span></div>
          {data.cases.slice(0, 5).map((item) => <div className="coordinator-mini-row" key={item._id}><div><b>{item.service === 'DIETITIAN' ? 'Dietitian consultation' : 'Specialist consultation'}</b><span>{item.reason || 'No reason recorded'}</span><small>Status: {item.status.replaceAll('_', ' ')} · Requested by: {item.requestedByUserId.slice(-6)} · Assigned: {item.assignedApexcareUserId ? item.assignedApexcareUserId.slice(-6) : 'Not assigned'}</small></div><Link className="secondary compact-action" href={`/patients/${item.patientId}`}>Patient <ArrowUpRight size={13} /></Link></div>)}
          {!data.cases.length && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No open service requests</b></div>}
        </div>
      </section>

      <section className="card glass section page-enter">
        <div className="section-head"><div><div className="eyebrow">Exception handling</div><h2>Coordinator escalations</h2><span className="muted">Human follow-up exceptions returned by the escalation service.</span></div><span className="badge danger">{data.escalations.length} open</span></div>
        {data.escalations.slice(0, 5).map((item) => <div className="coordinator-mini-row" key={item._id}><div><b>{(item.escalationType || 'Patient follow-up').replaceAll('_', ' ')}</b><span>{item.reason || 'System-generated follow-up required.'}</span><small>Created: {fmt(item.createdAt)} · Patient: {item.patientId ? item.patientId.slice(-6) : 'Not linked'} · Status: {item.status || 'OPEN'}</small></div><Link className="secondary compact-action" href="/care-queue">Review <ArrowUpRight size={13} /></Link></div>)}
        {!data.escalations.length && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No open escalations</b><span>The system has no unresolved coordinator exceptions.</span></div>}
      </section>
    </>
  );
}

function DashboardSkeleton() {
  return <div className="grid g4">{Array.from({ length: 4 }).map((_, i) => <div className="card glass skeleton-stat" key={i} />)}</div>;
}

export default function Dashboard() {
  return (
    <Gate>
      <RoleGate allowed={['CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR']}>
        <DashboardByRole />
      </RoleGate>
    </Gate>
  );
}

function DashboardByRole() {
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('apexcare_user');
      const parsed = raw ? JSON.parse(raw) : null;
      const roles = parsed?.roles || [];
      const currentRole = roles.includes('CLINIC_COORDINATOR') ? 'CLINIC_COORDINATOR' : roles[0] || null;
      setRole(currentRole);
      if (currentRole === 'CLINIC_COORDINATOR') router.replace('/care-queue');
    } catch { setRole(null); }
  }, [router]);

  if (role === 'CLINIC_ADMIN') return <Shell title="Good morning." subtitle="A business and operations view of your chronic-care clinic."><ClinicAdminDashboard /></Shell>;
  if (role === 'CLINICIAN') return <Shell title="Good morning." subtitle="A focused clinical command center for decisions that need you."><ClinicalDashboard /></Shell>;
  if (role === 'CLINIC_COORDINATOR') return <Shell title="Opening your care queue…" subtitle="Your coordinator worklist is loading."><div className="empty-state"><span className="loading-orb" /><b>Loading care queue…</b></div></Shell>;
  return <Shell title="Good morning." subtitle="Your patient to-do list and operational care workspace."><StaffDashboard /></Shell>;
}
