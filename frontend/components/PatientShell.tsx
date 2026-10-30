"use client";

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Activity, CalendarDays, CheckCircle2, Home, LogOut, Pill, UserRound } from 'lucide-react';

const links = [
  ['/patient', 'Home', Home],
  ['/patient/care', 'My care', CheckCircle2],
  ['/patient/medications', 'Medicines', Pill],
  ['/patient/profile', 'Profile', UserRound],
] as const;

export function PatientShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  function logout() {
    localStorage.removeItem('apexcare_token');
    localStorage.removeItem('apexcare_user');
    router.replace('/patient/login');
  }
  return <>
    <aside className="sidebar glass">
      <div className="brand"><div className="mark"><Activity size={20} /></div><div><b>ApexCare</b><small>Your care, simply</small></div></div>
      <div className="workspace-role glass-subtle"><div className="workspace-icon"><HeartIcon /></div><div><b>Patient app</b><small>Your personal care space</small></div></div>
      <nav>{links.map(([href,label,Icon]) => <Link key={href} href={href} className={pathname === href || pathname.startsWith(`${href}/`) ? 'nav active' : 'nav'}><Icon size={17}/>{label}</Link>)}</nav>
      <div className="sidebar-profile"><b>Private care space</b><small>Your clinical team sees only what they need for your care.</small></div>
      <button className="nav logout" onClick={logout}><LogOut size={17}/>Sign out</button>
    </aside>
    <nav className="mobile glass">{links.slice(0,4).map(([href,label,Icon]) => <Link key={href} href={href} className={pathname === href ? 'active' : ''} aria-label={label}><Icon size={19}/></Link>)}</nav>
    <main className="main"><header className="top"><div><div className="eyebrow">ApexCare Patient</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</main>
  </>;
}
function HeartIcon(){ return <CalendarDays size={15}/>; }
