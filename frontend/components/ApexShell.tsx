'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Activity, ClipboardList, HeartPulse, LogOut, Users, Utensils, ShieldCheck } from 'lucide-react';
import { me } from '@/lib/api';
import type { Me, Role } from '@/types/api';

const links: Array<readonly [string, string, React.ComponentType<{ size?: number }>, Role[]]> = [
  ['/apex', 'Overview', HeartPulse, ['APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST', 'APEXCARE_DOCTOR', 'PLATFORM_ADMIN']],
  ['/apex/queue', 'Work queue', ClipboardList, ['APEXCARE_COORDINATOR']],
  ['/apex/services', 'Service cases', Users, ['APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST']],
  ['/apex/dietitian', 'Dietitian', Utensils, ['APEXCARE_DIETITIAN']],
];

const roleLabels: Record<string, string> = {
  APEXCARE_COORDINATOR: 'ApexCare coordinator',
  APEXCARE_DIETITIAN: 'ApexCare dietitian',
  APEXCARE_SPECIALIST: 'ApexCare specialist',
  APEXCARE_DOCTOR: 'ApexCare doctor',
  PLATFORM_ADMIN: 'Platform administrator',
};

export function ApexShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = React.useState<Me | null>(null);
  React.useEffect(() => {
    const cached = localStorage.getItem('apexcare_user');
    if (cached) { try { setUser(JSON.parse(cached) as Me); } catch {} }
  }, []);
  const role = roleLabels[user?.roles?.[0] || ''] || 'ApexCare workspace';
  const visible = links.filter(([, , , allowed]) => user?.roles.some((r) => allowed.includes(r)));
  function logout() { localStorage.removeItem('apexcare_token'); localStorage.removeItem('apexcare_user'); router.replace('/apex/login'); }
  return <>
    <aside className="sidebar glass">
      <div className="brand"><div className="mark"><Activity size={20} /></div><div><b>ApexCare</b><small>Care operations</small></div></div>
      <div className="workspace-role glass-subtle"><div className="workspace-icon"><ShieldCheck size={15} /></div><div><b>{role}</b><small>Patient handoff workspace</small></div></div>
      <nav>{visible.map(([href, label, Icon]) => <Link className={pathname === href || pathname.startsWith(`${href}/`) ? 'nav active' : 'nav'} href={href} key={`${href}-${label}`}><Icon size={17} />{label}</Link>)}</nav>
      <div className="sidebar-profile"><b>{role}</b><small>ApexCare team</small></div>
      <button className="nav logout" onClick={logout}><LogOut size={17} />Sign out</button>
    </aside>
    <nav className="mobile glass">{visible.map(([href, label, Icon]) => <Link href={href} key={`${href}-${label}`} className={pathname === href ? 'active' : ''} aria-label={label} title={label}><Icon size={19} /></Link>)}</nav>
    <main className="main"><header className="top"><div><div className="eyebrow">ApexCare Team</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</main>
  </>;
}

export function ApexRoleGate({ children, allowed }: { children: React.ReactNode; allowed: Role[] }) {
  const router = useRouter();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    me().then((user) => {
      if (!active) return;
      if (user.mustChangePassword) { router.replace('/account/password'); return; }
      if (!user.roles.some((role) => allowed.includes(role))) { router.replace('/apex'); return; }
      localStorage.setItem('apexcare_user', JSON.stringify(user));
      setReady(true);
    }).catch(() => { localStorage.removeItem('apexcare_token'); router.replace('/apex/login'); });
    return () => { active = false; };
  }, [allowed.join('|'), router]);
  if (!ready) return <main className="session-loading"><div className="card glass session-loading-card page-enter"><div className="loading-orb" /><b>Securing your ApexCare workspace</b><span className="muted">Checking your team access…</span></div></main>;
  return <>{children}</>;
}
