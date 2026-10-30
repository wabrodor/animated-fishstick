'use client';

import React, { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { requestPasswordChange } from '@/lib/password';
import { me } from '@/lib/api';

export default function PasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirm) { setError('New passwords do not match.'); return; }
    if (newPassword.length < 12) { setError('Password must be at least 12 characters.'); return; }
    setBusy(true);
    try {
      await requestPasswordChange(currentPassword, newPassword);
      const user = await me();
      
      if (user.mustChangePassword) {
  throw new Error(
    'The password was changed, but the account is still marked for password change.'
  );
}
      const cached = localStorage.getItem('apexcare_user');
      if (cached) {
        try { localStorage.setItem('apexcare_user', JSON.stringify({ ...JSON.parse(cached), mustChangePassword: false })); } catch { /* no-op */ }
      }
      router.replace('/dashboard');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to change password.');
    } finally { setBusy(false); }
  }

  return <main className="login"><section className="card glass" style={{ width: 'min(460px,100%)' }}>
    <div className="brand"><div className="mark"><ShieldCheck size={20} /></div><div><b>Password update</b><small>Required before clinical access</small></div></div>
    <p className="muted" style={{ marginTop: 18, lineHeight: 1.6 }}>Your account was created with a temporary password. Set a permanent password to continue.</p>
    <form onSubmit={submit}>
      <div className="field"><label>Temporary password</label><input required type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></div>
      <div className="field"><label>New password</label><input required minLength={12} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></div>
      <div className="field"><label>Confirm new password</label><input required minLength={12} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
      {error && <div className="alert" style={{ color: '#b4233c' }}>{error}</div>}
      <button className="primary" disabled={busy} style={{ width: '100%', marginTop: 18 }}>{busy ? 'Updating…' : 'Set permanent password'}</button>
    </form>
  </section></main>;
}
