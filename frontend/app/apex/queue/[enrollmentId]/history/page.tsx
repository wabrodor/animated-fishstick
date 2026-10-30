'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, FileText, RefreshCw, Save, Send } from 'lucide-react';
import { ApexRoleGate, ApexShell } from '@/components/ApexShell';
import { Gate } from '@/components/Shell';
import { apexGeneralMedicalHistory, saveApexGeneralMedicalHistory } from '@/lib/api';
import { APEX_GENERAL_HISTORY_QUESTIONS, APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, APEX_GENERAL_HISTORY_SECTIONS } from '@/lib/apex-general-history';
import type { ApexCareGeneralHistory, ApexCareGeneralHistoryAnswer, ApexCareGeneralHistoryAnswerValue } from '@/types/api';

type AnswerState = Record<string, ApexCareGeneralHistoryAnswerValue | ''>;
type DetailState = Record<string, string>;

const ANSWER_OPTIONS: Array<{ value: ApexCareGeneralHistoryAnswerValue; label: string }> = [
  { value: 'YES', label: 'Yes' },
  { value: 'NO', label: 'No' },
  { value: 'UNKNOWN', label: 'Unknown' },
  { value: 'DECLINED', label: 'Patient declined' },
];

export default function GeneralHistoryPage() {
  return <Gate fallbackPath="/apex/login"><ApexRoleGate allowed={['APEXCARE_COORDINATOR']}><GeneralHistoryContent /></ApexRoleGate></Gate>;
}

function GeneralHistoryContent() {
  const params = useParams<{ enrollmentId: string }>();
  const enrollmentId = params.enrollmentId;
  const [history, setHistory] = useState<ApexCareGeneralHistory | null>(null);
  const [answerState, setAnswerState] = useState<AnswerState>({});
  const [detailState, setDetailState] = useState<DetailState>({});
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    try {
      const saved = await apexGeneralMedicalHistory(enrollmentId);
      setHistory(saved);
      setNotes(saved?.notes || '');
      const nextAnswers: AnswerState = {};
      const nextDetails: DetailState = {};
      for (const answer of saved?.answers || []) {
        nextAnswers[answer.questionId] = answer.answer;
        if (answer.details) nextDetails[answer.questionId] = answer.details;
      }
      setAnswerState(nextAnswers);
      setDetailState(nextDetails);
    } catch (e) {
      setLoadFailed(true);
      setError(e instanceof Error ? e.message : 'Unable to load general medical history.');
    } finally {
      setLoading(false);
    }
  }, [enrollmentId]);

  useEffect(() => { void load(); }, [load]);

  const readOnly = history?.status === 'RECORDED';
  const answeredCount = useMemo(() => APEX_GENERAL_HISTORY_QUESTIONS.filter((question) => Boolean(answerState[question.questionId])).length, [answerState]);
  const progress = Math.round((answeredCount / APEX_GENERAL_HISTORY_QUESTIONS.length) * 100);

  function buildAnswers(): ApexCareGeneralHistoryAnswer[] {
    return APEX_GENERAL_HISTORY_QUESTIONS.flatMap((question) => {
      const answer = answerState[question.questionId];
      if (!answer) return [];
      return [{
        questionId: question.questionId,
        section: question.section,
        question: question.question,
        answer,
        details: detailState[question.questionId]?.trim() || undefined,
      }];
    });
  }

  async function save(record: boolean) {
    setError(null);
    setSuccess(null);
    const errors: string[] = [];
    if (record) {
      for (const question of APEX_GENERAL_HISTORY_QUESTIONS) {
        const answer = answerState[question.questionId];
        if (!answer) errors.push(`Answer required: ${question.question}`);
        if (answer === 'YES' && question.detailsRequiredOnYes && !detailState[question.questionId]?.trim()) {
          errors.push(`Follow-up details required: ${question.question}`);
        }
      }
    }
    setValidationErrors(errors);
    if (errors.length) {
      setError(`Complete ${errors.length} outstanding item${errors.length === 1 ? '' : 's'} before recording.`);
      return;
    }

    setSaving(true);
    try {
      const saved = await saveApexGeneralMedicalHistory(enrollmentId, {
        questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION,
        answers: buildAnswers(),
        notes: notes.trim() || undefined,
        record,
      });
      setHistory(saved);
      setSuccess(record ? 'History recorded and saved to the patient record.' : 'Draft saved. You can return and continue later.');
      setValidationErrors([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save general medical history.');
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(true);
  }

  const statusLabel = history?.status === 'RECORDED' ? 'RECORDED' : history?.status?.replaceAll('_', ' ') || 'NOT STARTED';

  return (
    <ApexShell title="General medical history" subtitle="Coordinator intake · one patient · one saved history record">
      <div className="apex-history-form-topbar">
        <Link className="secondary compact-action" href="/apex/queue"><ArrowLeft size={14} /> Back to queue</Link>
        <span className={`badge ${history?.status === 'RECORDED' ? 'success' : 'blue'}`}>{statusLabel}</span>
      </div>

      <section className="card glass apex-history-form-summary">
        <div className="apex-history-form-summary-title"><div className="apex-history-form-icon"><FileText size={19} /></div><div><div className="eyebrow">Patient handoff</div><h2>Patient · {enrollmentId.slice(-6).toUpperCase()}</h2><p className="muted">Collect answers as reported by the patient. Do not infer missing details.</p></div></div>
        <div className="apex-history-progress"><div><span>Questionnaire completion</span><b>{answeredCount} / {APEX_GENERAL_HISTORY_QUESTIONS.length}</b></div><div className="apex-history-progress-track"><span style={{ width: `${progress}%` }} /></div></div>
        <p className="apex-history-privacy-note">Use <b>Unknown</b> when the patient cannot confirm an answer and <b>Patient declined</b> when they choose not to answer. Medication history remains in its separate workflow.</p>
      </section>

      {error && <div className="card glass alert-error section" role="alert">{error}<button type="button" className="secondary" onClick={() => void load()} disabled={loading}>Reload</button></div>}
      {success && <div className="card glass apex-history-success" role="status"><CheckCircle2 size={17} />{success}</div>}
      {history?.status === 'RECORDED' && <div className="card glass apex-history-success"><CheckCircle2 size={17} /><span>This coordinator-collected history has been recorded in the patient record. It is read-only; no clinician approval is required.</span></div>}

      {loading ? (
        <div className="card glass empty-state section"><span className="loading-orb" /><b>Loading saved answers…</b></div>
      ) : loadFailed ? (
        <div className="card glass empty-state section"><b>History not loaded</b><span>For safety, the form is locked until the saved history can be retrieved.</span><button type="button" className="secondary" onClick={() => void load()}>Retry loading</button></div>
      ) : (
        <form className="apex-history-form" onSubmit={handleSubmit}>
          {APEX_GENERAL_HISTORY_SECTIONS.map((section, sectionIndex) => {
            const questions = APEX_GENERAL_HISTORY_QUESTIONS.filter((question) => question.section === section.id);
            return (
              <section className="card glass apex-history-section" key={section.id}>
                <div className="apex-history-section-heading"><span>{String(sectionIndex + 1).padStart(2, '0')}</span><div><h2>{section.title}</h2><p>{section.description}</p></div></div>
                {section.id === 'REPRODUCTIVE' && <p className="apex-history-section-caution">Ask only when clinically relevant and appropriate. If the patient does not wish to answer, record “Patient declined”.</p>}
                {questions.map((question, index) => {
                  const answer = answerState[question.questionId] || '';
                  const needsDetails = answer === 'YES' && question.detailsRequiredOnYes;
                  return (
                    <fieldset className="apex-history-question" key={question.questionId} disabled={Boolean(readOnly)}>
                      <legend><span className="apex-history-question-number">{index + 1}.</span>{question.question}</legend>
                      <div className="apex-history-answer-grid">
                        {ANSWER_OPTIONS.map((option) => (
                          <label className={`apex-history-answer-option ${answer === option.value ? 'selected' : ''}`} key={option.value}>
                            <input
                              type="radio"
                              name={question.questionId}
                              value={option.value}
                              checked={answer === option.value}
                              onChange={() => {
                                setAnswerState((current) => ({ ...current, [question.questionId]: option.value }));
                                if (option.value !== 'YES') {
                                  setDetailState((current) => {
                                    const next = { ...current };
                                    delete next[question.questionId];
                                    return next;
                                  });
                                }
                              }}
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                      </div>
                      {needsDetails && <label className="apex-history-detail-field"><span>{question.detailPrompt}</span><textarea value={detailState[question.questionId] || ''} maxLength={2000} rows={2} onChange={(event) => setDetailState((current) => ({ ...current, [question.questionId]: event.target.value }))} placeholder="Record the details shared by the patient…" /></label>}
                    </fieldset>
                  );
                })}
              </section>
            );
          })}

          <section className="card glass apex-history-section">
            <div className="apex-history-section-heading"><span>07</span><div><h2>Additional notes</h2><p>Record context that does not fit the structured questions. Avoid duplicating medication history.</p></div></div>
            <label className="apex-history-detail-field"><span>Coordinator notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} maxLength={3000} disabled={Boolean(readOnly)} placeholder="Optional relevant context, source of information or items to clarify…" /></label>
          </section>

          {validationErrors.length > 0 && <div className="card glass apex-history-validation"><b>Items to complete</b><ul>{validationErrors.slice(0, 8).map((item) => <li key={item}>{item}</li>)}</ul>{validationErrors.length > 8 && <small>And {validationErrors.length - 8} more…</small>}</div>}

          <div className="apex-history-form-actions">
            {readOnly ? (
              <Link className="primary" href="/apex/queue">Return to coordinator queue <ArrowLeft size={14} /></Link>
            ) : (
              <>
                <button type="button" className="secondary" disabled={saving} onClick={() => void save(false)}><Save size={15} />{saving ? 'Saving…' : 'Save draft'}</button>
                <button type="submit" className="primary" disabled={saving}><Send size={15} />{saving ? 'Recording…' : 'Record history'}</button>
              </>
            )}
          </div>
        </form>
      )}
    </ApexShell>
  );
}
