'use client';

import { useEffect, useState } from 'react';

type Feedback = { id: number; ok: boolean };

export function ActionFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  useEffect(() => {
    const onFeedback = (event: Event) => {
      const detail = (event as CustomEvent<{ ok?: boolean }>).detail;
      setFeedback({ id: Date.now(), ok: Boolean(detail?.ok) });
    };
    window.addEventListener('apexcare:feedback', onFeedback);
    return () => window.removeEventListener('apexcare:feedback', onFeedback);
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 3200);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  if (!feedback) return null;
  return <div key={feedback.id} className={`action-feedback ${feedback.ok ? 'is-success' : 'is-error'}`} role="status" aria-live="polite">
    <span aria-hidden="true">{feedback.ok ? '🙂' : '🙁'}</span>
    <span>{feedback.ok ? 'Action completed.' : 'Could not complete that action. Please try again.'}</span>
  </div>;
}
