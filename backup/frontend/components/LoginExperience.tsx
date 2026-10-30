'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowRight, ShieldCheck, Stethoscope, UserRound, UsersRound } from 'lucide-react';
import { login } from '@/lib/api';
import type { Role } from '@/types/api';

type Experience = 'clinic' | 'apex' | 'patient';

const config: Record<Experience, {
  eyebrow: string;
  title: string;
  subtitle: string;
  badge: string;
  icon: typeof Activity;
  allowedRoles: Role[];
  successPath: string;
}> = {
  clinic: {
    eyebrow: 'Secure clinic access',
    title: 'Welcome back.',
    subtitle: 'A calm workspace for patients, care plans and today\'s clinical work.',
    badge: 'Clinic workspace',
    icon: Stethoscope,
    allowedRoles: ['CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'],
    successPath: '/dashboard',
  },
  apex: {
    eyebrow: 'ApexCare operations',
    title: 'Welcome to ApexCare.',
    subtitle: 'Coordinate escalations, referrals and specialist care across clinics.',
    badge: 'Apex workspace',
    icon: UsersRound,
    allowedRoles: ['APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST', 'APEXCARE_DOCTOR', 'PLATFORM_ADMIN'],
    successPath: '/apex',
  },
  patient: {
    eyebrow: 'Your care, simply presented',
    title: 'Welcome back.',
    subtitle: 'See what you need to do today and understand your care without medical jargon.',
    badge: 'Patient app',
    icon: UserRound,
    allowedRoles: ['PATIENT'],
    successPath: '/patient',
  },
};

export default function LoginExperience({ experience }: { experience: Experience }) {
  const router = useRouter();
  const copy = config[experience];
  const Icon = copy.icon;
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const result = await login(email.trim(), pw);
      const matches = result.user.roles.some((role) => copy.allowedRoles.includes(role));
      if (!matches) {
        throw Object.assign(new Error(`This account belongs to a different ApexCare workspace.`), { code: 'WRONG_WORKSPACE' });
      }
      localStorage.setItem('apexcare_token', result.accessToken);
      localStorage.setItem('apexcare_user', JSON.stringify(result.user));
      if (result.user.mustChangePassword) {
        router.push('/account/password');
        return;
      }
      router.push(copy.successPath);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login login-experience page-enter">
      <section className="card glass login-card">
        <div className="brand">
          <div className="mark"><Activity size={20} /></div>
          <div><b>ApexCare</b><small>{copy.badge}</small></div>
        </div>

        <div className="login-hero-icon glass-subtle">
          <Icon size={20} />
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="eyebrow">{copy.eyebrow}</div>
          <h1 className="login-title">{copy.title}</h1>
          <p className="muted login-subtitle">{copy.subtitle}</p>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input required autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@clinic.com" />
          </div>
          <div className="field">
            <label>Password</label>
            <input required autoComplete="current-password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
          </div>

          {err && <div className="alert alert-error page-enter" role="alert">{err}</div>}

          <button className="primary login-submit" disabled={busy} aria-busy={busy}>
            <span>{busy ? 'Signing in…' : 'Continue'}</span>
            <ArrowRight size={15} className={busy ? 'button-spinner' : ''} />
          </button>
        </form>

        <div className="login-security muted">
          <ShieldCheck size={15} />
          <span>Authentication and authorization are enforced by the ApexCare API.</span>
        </div>
      </section>
    </main>
  );
}
