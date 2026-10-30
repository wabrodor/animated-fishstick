"use client";
import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Gate, RoleGate } from '@/components/Shell';
import { PatientShell } from '@/components/PatientShell';
import { patientMe } from '@/lib/api';
import type { Patient } from '@/types/api';
export default function PatientProfile(){ const [patient,setPatient]=useState<Patient|null>(null); useEffect(()=>{patientMe().then(x=>setPatient(x.patient)).catch(()=>{});},[]); return <Gate fallbackPath="/patient/login"><RoleGate allowed={['PATIENT']}><PatientShell title="My profile" subtitle="Your basic information and communication preferences."><div className="card glass page-enter"><div className="section-head"><div><div className="eyebrow">Personal details</div><h2>{patient ? `${patient.name.first} ${patient.name.last||''}` : 'Loading…'}</h2></div><UserRound size={20}/></div>{patient&&<div className="mini-grid"><div><small>Phone</small><b>{patient.phone||'—'}</b></div><div><small>Language</small><b>{patient.preferredLanguage||'English'}</b></div><div><small>Contact</small><b>{patient.preferredContactChannel||'—'}</b></div><div><small>Record</small><b>{patient.medicalRecordNumber||'—'}</b></div></div>}</div></PatientShell></RoleGate></Gate>; }
