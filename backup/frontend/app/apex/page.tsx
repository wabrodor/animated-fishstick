'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ClipboardList, PhoneCall, Utensils, Users, CheckCircle2 } from 'lucide-react';
import { Gate } from '@/components/Shell';
import { ApexRoleGate, ApexShell } from '@/components/ApexShell';
import { apexCoordinatorQueue, apexReferrals, apexServiceCases } from '@/lib/api';
import type { ApexCareEnrollment, ApexCareReferral, DietitianServiceCase } from '@/types/api';

export default function ApexDashboard() {
  return <Gate fallbackPath="/apex/login"><ApexRoleGate allowed={['APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST', 'APEXCARE_DOCTOR', 'PLATFORM_ADMIN']}><ApexHome /></ApexRoleGate></Gate>;
}

function ApexHome() {
  const [role, setRole] = useState<string | null>(null);
  const [coordinator, setCoordinator] = useState<ApexCareEnrollment[]>([]);
  const [referrals, setReferrals] = useState<ApexCareReferral[]>([]);
  const [cases, setCases] = useState<DietitianServiceCase[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try { const u = JSON.parse(localStorage.getItem('apexcare_user') || '{}'); setRole(u.roles?.[0] || null); } catch {}
    Promise.allSettled([apexCoordinatorQueue(), apexReferrals(), apexServiceCases()]).then((results) => {
      const [queue, refs, service] = results;
      if (queue.status === 'fulfilled') setCoordinator(queue.value);
      if (refs.status === 'fulfilled') setReferrals(refs.value);
      if (service.status === 'fulfilled') setCases(service.value);
      if (results.every((x) => x.status === 'rejected')) setError('Unable to load ApexCare operations.');
    });
  }, []);

  const coordinatorView = role === 'APEXCARE_COORDINATOR';
  const dietitianView = role === 'APEXCARE_DIETITIAN';

  return <ApexShell title="Good morning." subtitle={coordinatorView ? 'Keep every clinic handoff moving.' : dietitianView ? 'Turn coordinator handoffs into nutrition assessments and care-plan drafts.' : 'A focused ApexCare operations workspace.'}>
    {error && <div className="card glass alert-error page-enter">{error}</div>}
    <section className="hero glass page-enter workspace-hero">
      <div><div className="eyebrow">ApexCare operations</div><h2>{coordinatorView ? 'Own the handoff from clinic to care team.' : dietitianView ? 'Work from contacted enrollments and submit a dietitian assessment.' : 'Work from the patient journey.'}</h2><p>Every card here represents work the ApexCare team can actually act on. Patient access remains bounded by backend role and organization rules.</p></div>
      {coordinatorView && <Link className="primary" href="/apex/queue">Open coordinator queue <ArrowUpRight size={14} /></Link>}
      {dietitianView && <Link className="primary" href="/apex/dietitian">Open dietitian queue <ArrowUpRight size={14} /></Link>}
    </section>
    <section className="grid g3 section">
      <div className="card glass stat page-enter"><PhoneCall size={19} /><small>Coordinator calls due</small><strong>{coordinator.length}</strong></div>
      <div className="card glass stat page-enter"><ClipboardList size={19} /><small>Clinic referrals</small><strong>{referrals.length}</strong></div>
      <div className="card glass stat page-enter"><Utensils size={19} /><small>Service cases</small><strong>{cases.length}</strong></div>
    </section>
    <section className="grid g2 section">
      <div className="card glass page-enter"><div className="section-head"><div><div className="eyebrow">Next actions</div><h2>{coordinatorView ? 'Patient contact' : dietitianView ? 'Assigned care' : 'Active work'}</h2></div><Users size={20} /></div>
        {(coordinatorView ? coordinator : cases).slice(0, 5).map((item) => <div className="signal-list-row" key={item._id}><div><b>Patient {item.patientId.slice(-6)}</b><span>{'coordinatorCallStatus' in item ? String(item.coordinatorCallStatus || 'PENDING').replaceAll('_', ' ') : String(item.status).replaceAll('_', ' ')}</span></div><ArrowUpRight size={15} /></div>)}
        {!(coordinatorView ? coordinator : cases).length && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No immediate work</b><span>Your queue is clear.</span></div>}
      </div>
      <div className="card glass page-enter"><div className="section-head"><div><div className="eyebrow">Handoff status</div><h2>Referral pipeline</h2></div><ClipboardList size={20} /></div>
        {referrals.slice(0, 5).map((ref) => <div className="signal-list-row" key={ref._id}><div><b>Patient {ref.patientId.slice(-6)}</b><span>{ref.condition || 'Chronic-care referral'} · {ref.status || 'PENDING'}</span></div><Badge value={ref.staffEscalatedAt ? 'ESCALATED' : 'NEW'} /></div>)}
        {!referrals.length && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No new clinic referrals</b></div>}
      </div>
    </section>
  </ApexShell>;
}

function Badge({ value }: { value: string }) { return <span className="badge blue">{value}</span>; }
