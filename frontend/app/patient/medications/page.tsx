"use client";
import { useEffect, useState } from 'react';
import { Pill, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Gate, RoleGate } from '@/components/Shell';
import { PatientShell } from '@/components/PatientShell';
import { patientCare } from '@/lib/api';
import type { PatientPortalData } from '@/types/api';
export default function PatientMedications(){ const [data,setData]=useState<PatientPortalData|null>(null); const [error,setError]=useState(''); useEffect(()=>{patientCare().then(setData).catch(e=>setError(e instanceof Error?e.message:'Unable to load medicines.'));},[]); return <Gate fallbackPath="/patient/login"><RoleGate allowed={['PATIENT']}><PatientShell title="My medicines" subtitle="Your current medicines in one place."><Link className="muted back-link" href="/patient"> <ArrowLeft size={14}/> My care</Link>{error&&<div className="card glass alert-error">{error}</div>}{!data?<div className="card glass skeleton-card"/>:<div className="grid g2 section">{data.medications.map(m=><div className="card glass page-enter" key={m._id}><div className="section-head"><div><div className="eyebrow">Active medicine</div><h2>{m.name}</h2></div><Pill size={20}/></div><p className="muted">{[m.strength,m.dose,m.route,m.frequency,m.duration].filter(Boolean).join(' • ')||'Use exactly as prescribed.'}</p>{m.instructions&&<div className="glass-subtle note-box">{m.instructions}</div>}</div>)}{!data.medications.length&&<div className="card glass empty-state"><Pill size={20}/><b>No active medicines</b><span>Your care team will update this when needed.</span></div>}</div>}</PatientShell></RoleGate></Gate>; }
