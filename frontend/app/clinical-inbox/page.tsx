"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronRight, RefreshCw, ShieldAlert, Stethoscope } from "lucide-react";
import { Gate, RoleGate, Shell } from "@/components/Shell";
import { clinicalReviewQueue, decideClinicalReview, patientById } from "@/lib/api";
import type { ClinicalReviewCase, Patient } from "@/types/api";

type Row = { item: ClinicalReviewCase; patient?: Patient };

export default function ClinicalInbox() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const items = await clinicalReviewQueue();
      const hydrated = await Promise.all(items.slice(0, 30).map(async (item) => {
        try { return { item, patient: await patientById(item.patientId) }; } catch { return { item }; }
      }));
      setRows(hydrated);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load clinical inbox.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function decide(id: string, decision: 'APPROVE' | 'REJECT' | 'ESCALATE_TO_APEXCARE') {
    setBusy(id);
    try { await decideClinicalReview(id, { decision, reason: decision === 'APPROVE' ? undefined : 'Reviewed from clinician inbox.' }); setRows((current) => current.filter((row) => row.item._id !== id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to update the review.'); }
    finally { setBusy(null); }
  }

  return <Gate><RoleGate allowed={["CLINICIAN"]}><Shell title="Clinical inbox" subtitle="Review the exceptions that need clinical judgment — not another dashboard to maintain.">
    <div className="inbox-hero glass page-enter"><div className="inbox-icon"><Stethoscope size={22}/></div><div><div className="eyebrow">Needs clinical judgment</div><h2>{loading ? 'Checking your inbox…' : `${rows.length} review${rows.length === 1 ? '' : 's'} need attention`}</h2><p>Medication verification cases are separated from routine operational work. The backend remains the authorization and clinical-state source of truth.</p></div><button className="secondary icon-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/><span className="desktop-only">Refresh</span></button></div>
    {error && <div className="card glass alert-error page-enter"><b>Inbox unavailable.</b><p>{error}</p><button className="secondary" onClick={() => void load()}>Try again</button></div>}
    {!loading && !error && !rows.length && <div className="card glass empty-state page-enter"><CheckCircle2 size={26}/><b>Your clinical inbox is clear</b><span>No medication review cases are waiting for your decision.</span></div>}
    <div className="inbox-list">{rows.map(({ item, patient }, index) => <article className="card glass review-card page-enter" style={{ animationDelay: `${index * 35}ms` }} key={item._id}>
      <div className="review-priority"><ShieldAlert size={18}/><span>Medication review</span></div>
      <div className="review-main"><div><div className="person"><div className="avatar">{patient ? `${patient.name.first[0]}${patient.name.last?.[0] || ''}` : '?'}</div><div><b>{patient ? `${patient.name.first} ${patient.name.last || ''}` : `Patient ${item.patientId.slice(-6)}`}</b><span>{patient?.medicalRecordNumber || 'Clinical review case'}</span></div></div><p>{item.reason || item.reasonCode?.replaceAll('_', ' ') || 'Prescription requires clinician review.'}</p></div><Link className="review-link" href={`/patients/${item.patientId}`}><span>Open patient</span><ChevronRight size={16}/></Link></div>
      <div className="review-actions"><button className="secondary" disabled={busy === item._id} onClick={() => void decide(item._id, 'REJECT')}>Reject</button><button className="secondary" disabled={busy === item._id} onClick={() => void decide(item._id, 'ESCALATE_TO_APEXCARE')}>Escalate</button><button className="primary" disabled={busy === item._id} onClick={() => void decide(item._id, 'APPROVE')}>{busy === item._id ? 'Saving…' : 'Approve verification'}</button></div>
    </article>)}</div>
  </Shell></RoleGate></Gate>;
}
