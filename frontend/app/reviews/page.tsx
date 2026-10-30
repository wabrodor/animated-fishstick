'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Check, CheckCircle2, ChevronLeft, ClipboardCheck, HeartPulse, LoaderCircle, MessageSquareText, Phone, RefreshCw, ShieldCheck, UserRoundX } from 'lucide-react';
import { Gate, RoleGate, Shell } from '@/components/Shell';
import { completeCoordinatorReview, coordinatorReviews, recordCoordinatorVitals, sendCoordinatorReviewMessage, updateCoordinatorReviewContact, visitAssist } from '@/lib/api';
import type { CoordinatorReview, PatientReviewAnswer, VisitAssist } from '@/types/api';

function formatDate(value: string) { return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
function formatDay(review: CoordinatorReview) { return `Day ${review.milestone.day} review`; }
function priorityLabel(priority: CoordinatorReview['priority']) { return priority === 'HIGH' ? 'Act now' : priority === 'MEDIUM' ? 'Due soon' : 'Planned'; }
function visitAssistAnswerKey(id: string) { return `visit-assist:${id}`; }
function visitAssistQuestionId(id: string, index: number) { return `va_${index}_${id}`.slice(0, 80); }

function ReviewsPage() {
  const searchParams = useSearchParams();
  const requestedReviewId = searchParams.get('reviewId');
  const autoOpenedReviewId = useRef<string | null>(null);
  const [reviews, setReviews] = useState<CoordinatorReview[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [contactNotes, setContactNotes] = useState('');
  const [systolic, setSystolic] = useState(''); const [diastolic, setDiastolic] = useState(''); const [pulse, setPulse] = useState(''); const [weight, setWeight] = useState('');
  const [vitalsId, setVitalsId] = useState<string | undefined>();
  const [savingVitals, setSavingVitals] = useState(false); const [savingReview, setSavingReview] = useState(false); const [contacting, setContacting] = useState(false); const [messaging, setMessaging] = useState(false); const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null); const [success, setSuccess] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const [visitBrief, setVisitBrief] = useState<VisitAssist | null>(null); const [loadingBrief, setLoadingBrief] = useState(false);
  const selected = useMemo(() => reviews?.find((review) => review._id === selectedId) ?? null, [reviews, selectedId]);

  const groups = useMemo(() => ({
    HIGH: reviews?.filter((item) => item.priority === 'HIGH') ?? [],
    MEDIUM: reviews?.filter((item) => item.priority === 'MEDIUM') ?? [],
    LOW: reviews?.filter((item) => item.priority === 'LOW') ?? [],
  }), [reviews]);


  async function load(refresh = false) { if (refresh) setRefreshing(true); setError(null); try { setReviews(await coordinatorReviews('OPEN')); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load reviews.'); } finally { setRefreshing(false); } }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!requestedReviewId || !reviews || autoOpenedReviewId.current === requestedReviewId) return;
    const review = reviews.find((item) => item._id === requestedReviewId);
    if (review) {
      autoOpenedReviewId.current = requestedReviewId;
      openReview(review);
    }
  }, [requestedReviewId, reviews]);
  function openReview(review: CoordinatorReview) { setSelectedId(review._id); setAnswers({}); setNotes(''); setContactNotes(review.contactNotes || ''); setSystolic(''); setDiastolic(''); setPulse(''); setWeight(''); setVitalsId(undefined); setSuccess(false); setMessage(null); setError(null); setVisitBrief(null); }
  function answer(questionId: string, value: string) { setAnswers((current) => ({ ...current, [questionId]: value })); }

  async function prepareBrief() {
    if (!selected) return;
    setLoadingBrief(true); setError(null);
    try { setVisitBrief(await visitAssist(selected.patientId)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to prepare coordinator questions.'); }
    finally { setLoadingBrief(false); }
  }

  async function updateContact(outcome: 'CONTACTED' | 'UNANSWERED') {
    if (!selected || contacting) return;
    const reviewId = selected._id;
    const trimmedNotes = contactNotes.trim();
    setContacting(true); setError(null); setMessage(null);
    try {
      const updated = await updateCoordinatorReviewContact(reviewId, outcome, trimmedNotes || undefined);
      // Merge against the selected ID (not just the response ID) so the UI remains
      // responsive if a proxy/serializer returns a partial review representation.
      setReviews((current) => current?.map((item) => item._id === reviewId ? {
        ...item,
        ...updated,
        _id: reviewId,
        status: updated.status ?? 'IN_PROGRESS',
        contactStatus: updated.contactStatus ?? outcome,
        contactNotes: trimmedNotes || updated.contactNotes || item.contactNotes,
        lastContactedAt: updated.lastContactedAt ?? new Date().toISOString(),
      } : item) ?? []);
      setMessage(outcome === 'CONTACTED'
        ? 'Contact outcome saved to ApexCare. The review remains open until the review information is collected.'
        : 'Unanswered contact outcome saved to ApexCare. The review remains open for another follow-up attempt.');
      // Reconcile with the backend after the success feedback is already visible.
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save the contact outcome.');
    } finally {
      setContacting(false);
    }
  }

  async function sendMessage() {
    if (!selected) return;
    setMessaging(true); setError(null); setMessage(null);
    try {
      const result = await sendCoordinatorReviewMessage(selected._id);
      setReviews((current) => current?.map((item) => item._id === selected._id ? { ...item, contactStatus: 'MESSAGE_QUEUED', status: 'IN_PROGRESS', lastContactedAt: new Date().toISOString() } : item) ?? []);
      setMessage(result?.queued ? 'Automated patient message queued.' : 'Automated patient message prepared.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to queue the patient message.'); } finally { setMessaging(false); }
  }

  async function saveVitals() {
    if (!selected) return;
    if (!systolic && !diastolic && !pulse && !weight) { setError('Enter at least one measurement before saving vitals.'); return; }
    if ((systolic && !diastolic) || (!systolic && diastolic)) { setError('Enter both systolic and diastolic values for a blood-pressure reading.'); return; }
    setSavingVitals(true); setError(null);
    try {
      const vital = await recordCoordinatorVitals(selected.patientId, {
        source: 'OPD',
        bloodPressure: systolic || diastolic || pulse ? { ...(systolic ? { systolic: Number(systolic) } : {}), ...(diastolic ? { diastolic: Number(diastolic) } : {}), ...(pulse ? { pulse: Number(pulse) } : {}) } : undefined,
        ...(weight ? { weightKg: Number(weight) } : {}),
      });
      setVitalsId(vital._id);
      setMessage('Vitals saved.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save vitals.'); } finally { setSavingVitals(false); }
  }

  async function completeReview() {
    if (!selected) return;
    setSavingReview(true); setError(null); setMessage(null);
    try {
      const standardAnswers: PatientReviewAnswer[] = selected.questions.map((question) => ({
        questionId: question.questionId,
        topic: question.topic,
        question: question.question,
        ...(answers[question.questionId]?.trim() ? { answer: answers[question.questionId].trim() } : {}),
      }));
      // The visit assistant supplies supplementary questions, not a second unsaved display.
      // Include their responses in the same completion payload so the backend persists them.
      const assistantAnswers: PatientReviewAnswer[] = (visitBrief?.questions.slice(0, 6) ?? []).map((question, index) => {
        const response = answers[visitAssistAnswerKey(question.id)]?.trim();
        return {
          questionId: visitAssistQuestionId(question.id, index),
          topic: question.topic,
          question: question.question,
          ...(response ? { answer: response } : {}),
        };
      });
      const reviewAnswers = [...standardAnswers, ...assistantAnswers];
      await completeCoordinatorReview(selected.patientId, selected._id, { answers: reviewAnswers, notes: notes.trim() || undefined, vitalsRecordId: vitalsId });
      setSuccess(true); setReviews((current) => current?.filter((item) => item._id !== selected._id) ?? []);
      setMessage('Review completed. The collected information is now available to the clinician.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to complete the review.'); } finally { setSavingReview(false); }
  }

  if (selected) return (
    <Shell title="Patient review" subtitle="Contact the patient, collect the operational information, then complete the review.">
      <div className="review-toolbar page-enter"><button className="secondary icon-button" onClick={() => setSelectedId(null)}><ChevronLeft size={16} /> Back to reviews</button><span className={`priority ${selected.priority.toLowerCase()}`}>{selected.priority} · {priorityLabel(selected.priority)}</span></div>
      <section className="review-patient-header glass page-enter"><div><div className="eyebrow">{formatDay(selected)}</div><h2>{selected.patient.name}</h2><p>{selected.patient.medicalRecordNumber || 'No MRN'} · {selected.patient.condition || 'Chronic care'} · due {formatDate(selected.dueAt)}{selected.daysOverdue ? ` · ${selected.daysOverdue} day${selected.daysOverdue === 1 ? '' : 's'} overdue` : ''}</p></div><div className="review-header-actions"><span className={`badge ${selected.contactStatus === 'UNANSWERED' ? 'danger' : selected.contactStatus === 'CONTACTED' ? 'success' : selected.contactStatus === 'MESSAGE_QUEUED' ? 'blue' : 'warn'}`}>{selected.contactStatus.replaceAll('_', ' ')}</span><div className="review-safety-note"><ShieldCheck size={17} /><span>Coordinator workflow. Clinical interpretation stays with the assigned clinician.</span></div></div></section>
      {error && <div className="card glass alert-error page-enter"><b>Review needs attention.</b><p>{error}</p></div>}
      {message && <div className="card glass page-enter inline-feedback"><b>{message}</b></div>}
      {success && <div className="card glass success-card page-enter"><CheckCircle2 size={20} /><div><b>Review completed.</b><span>The information is now available for clinician review.</span></div></div>}

      <section className="card glass section page-enter">
        <div className="section-head"><div><div className="eyebrow">Step 0</div><h2>Contact the patient</h2><span className="muted">Call first when appropriate, or queue the standard automated reminder. If there is no response, record it as unanswered.</span></div><Phone size={20} /></div>
        <div className="contact-action-grid">
          <a className="primary" href={selected.patient.phone ? `tel:${selected.patient.phone}` : undefined} aria-disabled={!selected.patient.phone}><Phone size={15} /> Call patient</a>
          <button className="secondary" onClick={() => void sendMessage()} disabled={messaging || !selected.patient.phone && !selected.patient.whatsapp}>{messaging ? <LoaderCircle size={15} className="button-spinner" /> : <MessageSquareText size={15} />}{messaging ? 'Queuing…' : 'Send automated message'}</button>
        </div>
        <div className="contact-outcome-row"><input value={contactNotes} onChange={(e) => setContactNotes(e.target.value)} placeholder="Optional contact note — e.g. left voicemail" /><button className="secondary" aria-pressed={selected.contactStatus === 'CONTACTED'} disabled={contacting} onClick={() => void updateContact('CONTACTED')}>{contacting ? <LoaderCircle size={15} className="button-spinner" /> : <Check size={15} />}{contacting ? 'Saving…' : selected.contactStatus === 'CONTACTED' ? 'Contact recorded' : 'Mark contacted'}</button><button className="secondary danger-action" aria-pressed={selected.contactStatus === 'UNANSWERED'} disabled={contacting} onClick={() => void updateContact('UNANSWERED')}>{contacting ? <LoaderCircle size={15} className="button-spinner" /> : <UserRoundX size={15} />}{contacting ? 'Saving…' : selected.contactStatus === 'UNANSWERED' ? 'Unanswered recorded' : 'Mark unanswered'}</button></div>
        {!selected.patient.phone && !selected.patient.whatsapp && <span className="muted">No phone/WhatsApp contact is recorded for this patient. Open the patient record to review available details.</span>}
      </section>

      <section className="grid g2 section">
        <div className="card glass page-enter"><div className="section-head"><div><div className="eyebrow">Step 1</div><h2>Record today&apos;s vitals</h2><span className="muted">Only enter what was actually measured.</span></div><HeartPulse size={20} /></div><div className="review-vitals-grid"><label>Systolic<input inputMode="numeric" value={systolic} onChange={(e) => setSystolic(e.target.value)} placeholder="—" /></label><label>Diastolic<input inputMode="numeric" value={diastolic} onChange={(e) => setDiastolic(e.target.value)} placeholder="—" /></label><label>Pulse<input inputMode="numeric" value={pulse} onChange={(e) => setPulse(e.target.value)} placeholder="—" /></label><label>Weight kg<input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="—" /></label></div><button className="secondary full-action" onClick={() => void saveVitals()} disabled={savingVitals || Boolean(vitalsId)}>{savingVitals ? <LoaderCircle size={15} className="button-spinner" /> : vitalsId ? <Check size={15} /> : <HeartPulse size={15} />}{vitalsId ? 'Vitals saved' : 'Save vitals'}</button></div>
        <div className="card glass page-enter">
          <div className="section-head">
            <div><div className="eyebrow">Step 2</div><h2>Review questionnaire</h2><span className="muted">One questionnaire: standard review items plus optional targeted prompts. All responses are submitted together.</span></div>
            <button className="secondary" onClick={() => void prepareBrief()} disabled={loadingBrief || selected.patient.condition !== 'HYPERTENSION'}>{loadingBrief ? 'Preparing…' : visitBrief ? 'Refresh questions' : 'Prepare questions'}</button>
          </div>
          {selected.patient.condition !== 'HYPERTENSION' && <p className="muted">Supplementary prompts are currently supported for hypertension patients only.</p>}
          {visitBrief && <div className="visit-gap-grid">{visitBrief.missingInformation.map((item) => <div className="visit-gap" key={item.key}><span className={`priority ${item.importance.toLowerCase()}`}>{item.importance}</span><b>{item.label}</b></div>)}</div>}
          {visitBrief && <p className="muted">{visitBrief.questions.length ? `${Math.min(visitBrief.questions.length, 6)} supplementary question(s) included below.` : 'No supplementary questions were needed for the available information.'}</p>}
          <div className="review-questions">
            {selected.questions.map((question) => <label className="review-question" key={question.questionId}>
              <span>{question.question}</span>
              <textarea value={answers[question.questionId] || ''} onChange={(e) => answer(question.questionId, e.target.value)} placeholder="Record response…" rows={3} />
            </label>)}
            {visitBrief && visitBrief.questions.slice(0, 6).map((question, index) => {
              const responseKey = visitAssistAnswerKey(question.id);
              const choices = question.answerType === 'YES_NO' ? ['Yes', 'No', 'Not sure'] : (question.choices ?? []);
              return <label className="review-question" key={`visit-assist-${question.id}`}>
                <span>{question.question} <small className="muted">· Follow-up prompt</small></span>
                {question.answerType === 'YES_NO' || (question.answerType === 'CHOICE' && choices.length > 0) ? (
                  <select value={answers[responseKey] || ''} onChange={(e) => answer(responseKey, e.target.value)}>
                    <option value="">Select response…</option>
                    {choices.map((choice) => <option value={choice} key={choice}>{choice}</option>)}
                  </select>
                ) : (
                  <textarea value={answers[responseKey] || ''} onChange={(e) => answer(responseKey, e.target.value)} placeholder="Record patient response…" rows={3} />
                )}
                <small className="muted">{question.reason}</small>
              </label>;
            })}
          </div>
          {visitBrief && visitBrief.questions.length > 0 && <p className="muted">Supplementary answers are saved when you mark this review complete.</p>}
        </div>
      </section>
      <section className="card glass section page-enter"><div className="section-head"><div><div className="eyebrow">Step 3</div><h2>Coordinator notes</h2><span className="muted">Operational context only. Do not enter treatment instructions.</span></div></div><textarea className="wide-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Travel, cost, work schedule, adherence barriers, patient concerns…" rows={4} /><div className="review-submit-row"><div className="muted">Complete only after the review information has been collected. An unanswered call alone does not complete the clinical review.</div><button className="primary" onClick={() => void completeReview()} disabled={savingReview || success}>{savingReview ? <LoaderCircle size={16} className="button-spinner" /> : <CheckCircle2 size={16} />}{savingReview ? 'Completing…' : 'Mark review complete'}{!savingReview && !success && <ArrowRight size={15} />}</button></div></section>
    </Shell>
  );

  return <Shell title="Patient review queue" subtitle="Pending reviews are the coordinator's contact work: identify who needs attention, contact them, record the outcome, and complete the review when information is collected.">
    <div className="section-head page-enter"><div><div className="eyebrow">Coordinator workflow</div><span className="muted">The backend is the source of truth for review status. Priority is calculated from due time; clinical interpretation stays with the clinician.</span></div><button className="secondary icon-button" onClick={() => void load(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'button-spinner' : ''} /><span className="desktop-only">Refresh</span></button></div>
    {error && <div className="card glass alert-error page-enter"><b>Reviews unavailable.</b><p>{error}</p><button className="secondary" onClick={() => void load(true)}>Try again</button></div>}
    {message && <div className="card glass page-enter inline-feedback"><b>{message}</b></div>}
    {!reviews && !error && <div className="grid g2 section">{[1,2].map((i) => <div className="card glass skeleton-stat" key={i} />)}</div>}
    {reviews && <div className="grid g3 section"><div className="card glass stat"><small>Pending reviews</small><strong>{reviews.length}</strong><span className="muted">Open or in progress</span></div><div className="card glass stat"><small>High priority</small><strong>{groups.HIGH.length}</strong><span className="muted">Overdue or due within 24h</span></div><div className="card glass stat"><small>Unanswered</small><strong>{reviews.filter((item) => item.contactStatus === 'UNANSWERED').length}</strong><span className="muted">Needs another contact attempt</span></div></div>}
    {reviews && !reviews.length && <div className="card glass empty-state page-enter"><CheckCircle2 size={22} /><b>No reviews waiting</b><span>When a care-plan milestone requires coordinator follow-up, it will appear here.</span></div>}
    {reviews && reviews.length > 0 && <section className="review-list section">{(['HIGH', 'MEDIUM', 'LOW'] as const).map((priority) => <div className="task-priority-group" key={priority}><div className="task-priority-heading"><span className={`priority ${priority.toLowerCase()}`}>{priority}</span><span>{priorityLabel(priority)}</span><b>{groups[priority].length}</b></div>{groups[priority].map((review, index) => <button className="review-card glass page-enter" key={review._id} style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }} onClick={() => openReview(review)}><div className="review-card-main"><div className="review-day">{formatDay(review)} · {review.contactStatus.replaceAll('_', ' ')}</div><h2>{review.patient.name}</h2><p>{review.patient.medicalRecordNumber || 'No MRN'} · {review.patient.condition || 'Care review'} · {review.daysOverdue ? `${review.daysOverdue} day${review.daysOverdue === 1 ? '' : 's'} overdue` : `Due ${formatDate(review.dueAt)}`}</p></div><div className="review-card-meta"><span className={`badge ${review.contactStatus === 'UNANSWERED' ? 'danger' : review.contactStatus === 'CONTACTED' ? 'success' : 'warn'}`}>{review.contactStatus.replaceAll('_', ' ')}</span><ArrowRight size={18} /></div></button>)}</div>)}</section>}
  </Shell>;
}

export default function CoordinatorReviews() { return <Gate><RoleGate allowed={['CLINIC_COORDINATOR']}><ReviewsPage /></RoleGate></Gate>; }
