'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CheckCircle2, ClipboardList, Clock3, PhoneCall, RefreshCw } from 'lucide-react';
import { ApexRoleGate, ApexShell } from '@/components/ApexShell';
import { Gate } from '@/components/Shell';
import { apexCoordinatorQueue, updateCoordinatorCall } from '@/lib/api';
import type { ApexCareEnrollment } from '@/types/api';

function historyLabel(status?: ApexCareEnrollment['generalHistoryStatus']) {
  switch (status) {
    case 'IN_PROGRESS': return 'History in progress';
    case 'RECORDED': return 'History recorded';
    case 'NOT_STARTED':
    default: return 'History not started';
  }
}

function historyAction(status?: ApexCareEnrollment['generalHistoryStatus']) {
  if (status === 'RECORDED') return 'View recorded history';
  return status === 'IN_PROGRESS' ? 'Continue history' : 'Start history';
}

export default function ApexQueue() {
  return (
    <Gate fallbackPath="/apex/login">
      <ApexRoleGate allowed={['APEXCARE_COORDINATOR']}>
        <QueueContent />
      </ApexRoleGate>
    </Gate>
  );
}

function QueueContent() {
  const [items, setItems] = useState<ApexCareEnrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      setItems(await apexCoordinatorQueue());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load coordinator queue.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function contact(id: string, status: 'NO_ANSWER') {
    setBusy(id);
    setError(null);
    try {
      const updated = await updateCoordinatorCall(id, status);
      // Do not remove CONTACTED patients: their general-history task is independent.
      setItems((current) => current?.map((item) => item._id === id ? { ...item, ...updated } : item) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update contact status.');
    } finally {
      setBusy(null);
    }
  }

  const historyPending = (items || []).filter((item) => ['NOT_STARTED', 'IN_PROGRESS'].includes(item.generalHistoryStatus || 'NOT_STARTED')).length;

  return (
    <ApexShell title="Coordinator queue" subtitle="Contact the patient, then record the structured general history to start a clinician-review draft.">
      <section className="grid g3 section apex-history-queue-stats" aria-label="Coordinator workload">
        <div className="card glass stat"><PhoneCall size={18} /><small>Patients in queue</small><strong>{items?.length ?? '…'}</strong></div>
        <div className="card glass stat"><ClipboardList size={18} /><small>History to complete</small><strong>{items ? historyPending : '…'}</strong></div>
        <div className="card glass stat"><Clock3 size={18} /><small>Awaiting call outcome</small><strong>{items ? items.filter((item) => !item.coordinatorCallStatus || ['PENDING', 'NO_ANSWER', 'ESCALATED'].includes(item.coordinatorCallStatus)).length : '…'}</strong></div>
      </section>

      <section className="card glass page-enter apex-history-queue-panel">
        <div className="section-head apex-history-queue-head">
          <div><div className="eyebrow">Today’s work</div><h2>{items?.length ?? '…'} active patient handoffs</h2><span className="muted">Recording the general history automatically marks the coordinator contact complete.</span></div>
          <button type="button" className="secondary icon-button" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh coordinator queue"><RefreshCw size={15} className={refreshing ? 'button-spinner' : ''} /></button>
        </div>

        {error && <div className="alert alert-error" role="alert">{error}<button type="button" className="secondary" onClick={() => void load(true)}>Retry</button></div>}
        {items === null && !error && <div className="empty-state"><span className="loading-orb" /><b>Loading patient handoffs…</b></div>}

        {items?.map((item) => {
          const historyStatus = item.generalHistoryStatus || 'NOT_STARTED';
          const historyLocked = historyStatus === 'RECORDED';
          return (
            <article className="apex-history-queue-row" key={item._id}>
              <div className="apex-history-queue-main">
                <div className="apex-history-queue-icon"><PhoneCall size={17} /></div>
                <div className="apex-history-queue-copy">
                  <b>{item.patient ? `${item.patient.name.first} ${item.patient.name.last || ''}`.trim() : 'Patient'}</b>
                  <span>{item.patient?.phone || 'Phone not recorded'} · {String(item.patient?.preferredContactChannel || 'PHONE').replaceAll('_', ' ')}</span>
                  <span>Call: {String(item.coordinatorCallStatus || 'PENDING').replaceAll('_', ' ')}</span>
                  <span>General history: {historyLabel(historyStatus)}</span>
                  <small>Due: {item.coordinatorCallDueAt ? new Date(item.coordinatorCallDueAt).toLocaleString() : 'Today'}</small>
                </div>
              </div>
              <div className="apex-history-queue-actions">
                <div className="apex-history-contact-actions">
                  <button type="button" className="secondary compact-action" disabled={busy === item._id || historyLocked} onClick={() => void contact(item._id, 'NO_ANSWER')}>No answer</button>
                </div>
                {historyLocked ? (
                  <span className="badge success">{historyAction(historyStatus)}</span>
                ) : (
                  <Link className="primary compact-action" href={`/apex/queue/${item._id}/history`}>
                    {historyAction(historyStatus)} <ArrowUpRight size={13} />
                  </Link>
                )}
              </div>
            </article>
          );
        })}

        {items?.length === 0 && <div className="empty-state"><CheckCircle2 size={24} /><b>Coordinator queue is clear</b><span>Patients will return to this queue when a new handoff or incomplete history needs action.</span></div>}
      </section>
    </ApexShell>
  );
}
