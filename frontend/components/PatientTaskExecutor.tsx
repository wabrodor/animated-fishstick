"use client";

import { useState } from 'react';
import { ArrowRight, CheckCircle2, FlaskConical, HeartPulse, Pill, Stethoscope } from 'lucide-react';
import { completePatientTask } from '@/lib/api';
import type { PatientPortalData } from '@/types/api';

type Task = PatientPortalData['tasks'][number];

function taskInstruction(type: string) {
  switch (type) {
    case 'VITALS':
      return 'Your clinic needs a blood-pressure or vital reading for this step.';
    case 'MEDICATION':
      return 'Confirm this care step only after you have followed the clinician-approved instruction.';
    case 'LAB':
      return 'Complete the requested laboratory step, then confirm it here.';
    case 'OPD_VISIT':
      return 'Complete the scheduled clinic visit, then confirm attendance.';
    case 'FOLLOW_UP':
      return 'Complete the follow-up requested by your care team.';
    default:
      return 'Complete this step when you are ready.';
  }
}

function TaskIcon({ type }: { type: string }) {
  if (type === 'VITALS') return <HeartPulse size={18} />;
  if (type === 'MEDICATION') return <Pill size={18} />;
  if (type === 'LAB') return <FlaskConical size={18} />;
  return <Stethoscope size={18} />;
}

export function PatientTaskExecutor({
  task,
  onCompleted,
  onClose,
}: {
  task: Task;
  onCompleted: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function complete() {
    try {
      setBusy(true);
      setError('');
      await completePatientTask(task._id, 'COMPLETED');
      onCompleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update this task.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="patient-executor card page-enter" aria-label="Task execution">
      <div className="section-head">
        <div>
          <div className="eyebrow">Task</div>
          <h2>{task.title}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close task">×</button>
      </div>
      <div className="patient-executor-type"><span><TaskIcon type={task.type} /></span><b>{task.type.replaceAll('_', ' ')}</b></div>
      <p className="patient-executor-copy">{taskInstruction(task.type)}</p>

      {task.type === 'VITALS' ? (
        <div className="patient-executor-note">
          <HeartPulse size={18} />
          <div>
            <b>Vital entry is clinic-connected</b>
            <span>The current backend contract does not expose a patient-side vital-record endpoint. We will not store a clinical value in the browser or pretend this step is complete.</span>
          </div>
        </div>
      ) : (
        <button className="primary full-action" disabled={busy} onClick={complete}>
          {busy ? 'Saving…' : 'Mark complete'} <CheckCircle2 size={16} />
        </button>
      )}

      {error && <div className="alert alert-error page-enter" role="alert">{error}</div>}
      <button className="text-link patient-executor-back" onClick={onClose}>Back to today <ArrowRight size={14} /></button>
    </section>
  );
}
