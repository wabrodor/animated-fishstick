'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, ShieldCheck, Users, WalletCards } from 'lucide-react';
import { Gate, RoleGate, Shell } from '@/components/Shell';
import { subscription } from '@/lib/api';
import type { SubscriptionSummary } from '@/types/api';

export default function SubscriptionPage() {
  return <Gate><RoleGate allowed={['CLINIC_ADMIN']}><Shell title="Subscription" subtitle="Clinic capacity and billing-period status."><SubscriptionContent /></Shell></RoleGate></Gate>;
}

function SubscriptionContent() {
  const [data, setData] = useState<SubscriptionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { subscription().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Unable to load subscription.')); }, []);
  if (error) return <div className="card glass alert-error page-enter"><b>Subscription unavailable.</b><p>{error}</p></div>;
  if (!data) return <div className="grid g3"><div className="card glass skeleton-stat" /><div className="card glass skeleton-stat" /><div className="card glass skeleton-stat" /></div>;
  const usage = data.activePatientLimit ? Math.round(data.activePatientCount / data.activePatientLimit * 100) : 0;
  return <>
    <section className="hero glass page-enter workspace-hero"><div><div className="eyebrow">Clinic plan</div><h2>{data.planCode}</h2><p>Your backend subscription is the source of truth for active-patient capacity and period status.</p></div><ShieldCheck size={28} /></section>
    <section className="grid g3 section">
      <div className="card glass stat"><WalletCards size={19} /><small>Status</small><strong>{data.status}</strong><span className="muted">Current plan state</span></div>
      <div className="card glass stat"><Users size={19} /><small>Patient capacity</small><strong>{data.activePatientCount}/{data.activePatientLimit}</strong><span className="muted">{usage}% utilized</span></div>
      <div className="card glass stat"><ShieldCheck size={19} /><small>Available slots</small><strong>{data.availablePatientSlots}</strong><span className="muted">Before the current limit</span></div>
    </section>
    <section className="card glass section page-enter"><div className="section-head"><div><div className="eyebrow">Billing period</div><h2>Subscription timeline</h2></div></div><div className="mini-grid"><div><small>Period starts</small><b>{data.currentPeriodStart ? new Date(data.currentPeriodStart).toLocaleDateString() : '—'}</b></div><div><small>Period ends</small><b>{data.currentPeriodEnd ? new Date(data.currentPeriodEnd).toLocaleDateString() : '—'}</b></div><div><small>Next action</small><b>{data.availablePatientSlots < 5 ? 'Review capacity' : 'Continue care delivery'}</b></div></div><div className="inline-feedback">Revenue and invoices are intentionally not fabricated here. Add a billing endpoint when actual financial data is available.</div></section>
  </>;
}
