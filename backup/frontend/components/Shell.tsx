'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  ClipboardList,
  LayoutDashboard,
  UserPlus,
  Users,
  HeartPulse,
  LogOut,
  ShieldCheck,
  HeartHandshake,
  WalletCards,
} from 'lucide-react';
import { me } from '@/lib/api';
import { NotificationCenter } from '@/components/NotificationCenter';
import type { Me, Role } from '@/types/api';

const roleLabel: Record<string, string> = {
  CLINIC_ADMIN: 'Clinic administrator',
  CLINICIAN: 'Clinician',
  CLINIC_COORDINATOR: 'Care coordinator',
};

function linksForRole(roles: Role[]) {
  const isAdmin = roles.includes('CLINIC_ADMIN');
  const isClinician = roles.includes('CLINICIAN');
  const isCoordinator = roles.includes('CLINIC_COORDINATOR');

  if (isAdmin) {
    return [
      ['/dashboard', 'Overview', LayoutDashboard],
      ['/patients', 'Patients', Users],
      ['/care-queue', 'Operations', ClipboardList],
      ['/team', 'Care team', HeartPulse],
      ['/admin/subscription', 'Subscription', WalletCards],
    ] as const;
  }

  if (isClinician) {
    return [
      ['/dashboard', 'Clinical home', LayoutDashboard],
      ['/patients/new', 'Add patient', UserPlus],
      ['/clinical-inbox', 'Clinical inbox', Activity],
      ['/patients', 'Patients', Users],
    ] as const;
  }

  if (isCoordinator) {
    return [
      ['/dashboard', 'Today', LayoutDashboard],
      ['/care-queue', 'Care queue', ClipboardList],
      ['/reviews', 'Reviews', HeartHandshake],
      ['/enrollment', 'Enrollments', UserPlus],
      ['/patients', 'Patients', Users],
    ] as const;
  }

  return [['/dashboard', 'Overview', LayoutDashboard]] as const;
}



export function Shell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = React.useState<Me | null>(null);

  React.useEffect(() => {
    const cached = localStorage.getItem('apexcare_user');

    if (!cached) return;

    try {
      setUser(JSON.parse(cached) as Me);
    } catch {
      // Ignore stale cache.
    }
  }, []);

  const links = linksForRole(user?.roles || []);

  const role =
    roleLabel[user?.roles?.[0] || ''] || 'Clinic workspace';

  const isAdmin = user?.roles.includes('CLINIC_ADMIN') ?? false;
  const isClinician = user?.roles.includes('CLINICIAN') ?? false;
  const isCoordinator =
    user?.roles.includes('CLINIC_COORDINATOR') ?? false;

  const contextLabel = isAdmin
    ? 'Clinic operations'
    : isClinician
      ? 'Clinical workspace'
      : isCoordinator
        ? 'Care coordination'
        : 'Clinic workspace';

  function logout() {
    localStorage.removeItem('apexcare_token');
    localStorage.removeItem('apexcare_user');
    router.replace('/clinic/login');
  }

  return (
    <>
      <aside className="sidebar glass">
        <div className="brand">
          <div className="mark">
            <Activity size={20} />
          </div>

          <div>
            <b>ApexCare</b>
            <small>Clinic intelligence</small>
          </div>
        </div>

        <div className="workspace-role glass-subtle">
          <div className="workspace-icon">
            {isAdmin ? (
              <ShieldCheck size={15} />
            ) : isClinician ? (
              <Activity size={15} />
            ) : (
              <ClipboardList size={15} />
            )}
          </div>

          <div>
            <b>{role}</b>
            <small>{contextLabel}</small>
          </div>
        </div>

        <nav>
          {links.map(([href, label, Icon]) => (
            <Link
              className={
                pathname === href || pathname.startsWith(`${href}/`)
                  ? 'nav active'
                  : 'nav'
              }
              href={href}
              key={`${href}-${label}`}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-profile">
          <b>{role}</b>
          <small>{contextLabel}</small>
        </div>

        <button className="nav logout" onClick={logout}>
          <LogOut size={17} />
          Sign out
        </button>
      </aside>

      <nav className="mobile glass">
        {links.map(([href, label, Icon]) => (
          <Link
            href={href}
            key={`${href}-${label}`}
            className={pathname === href ? 'active' : ''}
            aria-label={label}
            title={label}
          >
            <Icon size={19} />
          </Link>
        ))}
      </nav>

      <main className="main">
        <header className="top">
          <div>
            <div className="eyebrow">ApexCare Clinic</div>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <NotificationCenter />
        </header>

        {children}
      </main>
    </>
  );
}

export function Gate({ children, fallbackPath = '/clinic/login' }: { children: React.ReactNode; fallbackPath?: string }) {
  const router = useRouter();
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    let active = true;

    async function check() {
      if (!localStorage.getItem('apexcare_token')) {
        router.replace(fallbackPath);
        return;
      }

      try {
        const user = await me();

        localStorage.setItem(
          'apexcare_user',
          JSON.stringify(user),
        );

        if (user.mustChangePassword) {
          router.replace('/account/password');
          return;
        }

        if (active) {
          setChecked(true);
        }
      } catch {
        localStorage.removeItem('apexcare_token');
        localStorage.removeItem('apexcare_user');
        router.replace(fallbackPath);
      }
    }

    check();

    return () => {
      active = false;
    };
  }, [fallbackPath, router]);

  return checked ? (
    <>{children}</>
  ) : (
    <main className="session-loading">
      <div className="card glass session-loading-card page-enter">
        <div className="loading-orb" aria-hidden="true" />
        <b>Securing your workspace</b>
        <span className="muted">Checking your ApexCare session…</span>
      </div>
    </main>
  );
}

export function RoleGate({
  children,
  allowed,
}: {
  children: React.ReactNode;
  allowed: Role[];
}) {
  const router = useRouter();
  const [ready, setReady] = React.useState(false);
  const [allowedForUser, setAllowedForUser] =
    React.useState(false);

  React.useEffect(() => {
    let active = true;

    async function checkRole() {
      try {
        const user = await me();

        if (!active) return;

        if (user.mustChangePassword) {
          router.replace('/account/password');
          return;
        }

        const permitted = user.roles.some((role) =>
          allowed.includes(role),
        );

        setAllowedForUser(permitted);
        setReady(true);

        if (!permitted) {
          router.replace('/dashboard');
        }
      } catch {
        localStorage.removeItem('apexcare_token');
        localStorage.removeItem('apexcare_user');
        router.replace('/clinic/login');
      }
    }

    checkRole();

    return () => {
      active = false;
    };
  }, [allowed.join('|'), router]);

  if (!ready || !allowedForUser) {
    return (
      <main className="login">
        <div
          className="card glass"
          style={{
            width: 'min(460px,100%)',
            textAlign: 'center',
          }}
        >
          Checking your workspace…
        </div>
      </main>
    );
  }

  return <>{children}</>;
}