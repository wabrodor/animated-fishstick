"use client";

import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Clock3, Pill, Sparkles, Stethoscope, ArrowRight } from 'lucide-react';
import { Gate, RoleGate } from '@/components/Shell';
import { PatientShell } from '@/components/PatientShell';
import { completePatientTask, patientCare } from '@/lib/api';
import type { PatientPortalData } from '@/types/api';
import Link from 'next/link';

function niceDate(value?: string) { return value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'; }
function taskTone(status: string) { return status === 'OVERDUE' ? 'danger' : status === 'COMPLETED' ? 'success' : 'blue'; }

export default function PatientWorkspace() {
  const [data,setData] = useState<PatientPortalData|null>(null);
  const [busy,setBusy] = useState<string|null>(null);
  const [error,setError] = useState('');
  async function load(){ try { setError(''); setData(await patientCare()); } catch(e){ setError(e instanceof Error ? e.message : 'Unable to load your care plan.'); } }
  useEffect(()=>{ load(); },[]);
  const firstName = data?.patient.name.first || 'there';
  const nextTask = data?.pendingTasks?.[0];
  const completion = data?.totalTasks ? Math.round((data.completedTasks / data.totalTasks)*100) : 0;
  async function finish(id:string){ try { setBusy(id); await completePatientTask(id,'COMPLETED'); await load(); } catch(e){ setError(e instanceof Error ? e.message : 'Unable to update the task.'); } finally { setBusy(null); } }
  return <Gate fallbackPath="/patient/login"><RoleGate allowed={['PATIENT']}><PatientShell title={`Good morning, ${firstName}`} subtitle="A simple view of what matters today.">
    {error && <div className="card glass alert-error page-enter"><b>We couldn't refresh your care.</b><p>{error}</p></div>}
    {!data ? <div className="grid g2 section"><div className="card glass skeleton-card"/><div className="card glass skeleton-card"/></div> : <>
      <section className="hero glass page-enter workspace-hero"><div><div className="eyebrow">Your care today</div><h2>{nextTask ? nextTask.title : 'You are up to date.'}</h2><p>{nextTask ? `Due ${niceDate(nextTask.dueAt)}. Small steps add up.` : 'There are no pending care tasks right now.'}</p></div>{nextTask && <button className="primary" disabled={busy===nextTask._id} onClick={()=>finish(nextTask._id)}>{busy===nextTask._id ? 'Saving…' : 'Mark done'} <CheckCircle2 size={15}/></button>}</section>
      <section className="grid g3 section"><div className="card glass stat page-enter"><CheckCircle2 size={19}/><small>Care progress</small><strong>{completion}%</strong><span className="muted">{data.completedTasks} of {data.totalTasks} tasks</span></div><div className="card glass stat page-enter"><Pill size={19}/><small>Active medicines</small><strong>{data.medications.length}</strong><span className="muted">Current prescriptions</span></div><div className="card glass stat page-enter"><Activity size={19}/><small>Care plan</small><strong>{data.plan ? 'Active' : 'Preparing'}</strong><span className="muted">{data.plan?.condition?.replaceAll('_',' ') || 'Your team is preparing your plan'}</span></div></section>
      <section className="grid g2 section"><div className="card glass page-enter"><div className="section-head"><div><div className="eyebrow">Next steps</div><h2>Your tasks</h2></div><Sparkles size={20}/></div>{data.pendingTasks.slice(0,6).map(task=><div className="signal-list-row" key={task._id}><div><b>{task.title}</b><span>Due {niceDate(task.dueAt)}</span></div><button className={`secondary ${busy===task._id?'loading':''}`} disabled={busy===task._id} onClick={()=>finish(task._id)}>Done</button></div>)}{!data.pendingTasks.length&&<div className="empty-state compact"><CheckCircle2 size={18}/><b>Nothing due right now</b><span>We'll keep your care plan here as new tasks arrive.</span></div>}</div>
      <div className="card glass page-enter"><div className="section-head"><div><div className="eyebrow">Your medicines</div><h2>Current medicines</h2></div><Pill size={20}/></div>{data.medications.slice(0,5).map(m=><div className="signal-list-row" key={m._id}><div><b>{m.name}{m.strength ? ` ${m.strength}`:''}</b><span>{[m.dose,m.frequency,m.instructions].filter(Boolean).join(' • ') || 'Follow your prescription.'}</span></div></div>)}{!data.medications.length&&<div className="empty-state compact"><Pill size={18}/><b>No active medicines listed</b><span>Your clinic team will update this section.</span></div>}<Link className="secondary full-action" href="/patient/medications">View medicines <ArrowRight size={14}/></Link></div></section>
      <section className="card glass section page-enter"><div className="section-head"><div><div className="eyebrow">Lab results</div><h2>What your results mean</h2></div><Stethoscope size={20}/></div>{data.labSummaries.slice(0,4).map(item=><div className="patient-summary" key={item._id}><div className="patient-summary-icon"><Stethoscope size={16}/></div><div><b>Reviewed by your clinical team</b><p>{item.patientApprovedSummary}</p><small className="muted">{niceDate(item.createdAt)}</small></div></div>)}{!data.labSummaries.length&&<div className="empty-state compact"><Clock3 size={18}/><b>No patient-friendly lab explanation yet</b><span>When your clinician reviews a result, the simple explanation will appear here.</span></div>}</section>
    </>}
  </PatientShell></RoleGate></Gate>;
}
