"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CalendarClock, Check, CheckCircle2, ClipboardList, FlaskConical, HeartPulse, LoaderCircle, MessageSquareText, Phone, RefreshCw, Search, ShieldAlert, UserPlus, UserRoundX, Users, Utensils, Stethoscope, XCircle } from "lucide-react";
import { Shell, Gate, RoleGate } from "@/components/Shell";
import { apexcareReferrals, completeCoordinatorTask, coordinatorEscalations, coordinatorReviews, newDiagnosisQueue, queue, resolveCoordinatorEscalation, sendCoordinatorReviewMessage, sendCoordinatorTaskMessage, serviceCases, updateCoordinatorReviewContact, updateCoordinatorTaskContact } from "@/lib/api";
import type { ApexCareReferral, CareQueue, CareQueueTask, CoordinatorEscalation, CoordinatorReview, NewDiagnosisQueueItem, ServiceCase } from "@/types/api";

type Filter = "ALL" | "URGENT" | "REVIEWS" | "CARE_TASKS" | "ENROLLMENT" | "ESCALATIONS" | "SERVICES";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "ALL", label: "All work" }, { id: "URGENT", label: "Act now" }, { id: "REVIEWS", label: "Patient reviews" }, { id: "CARE_TASKS", label: "Care tasks" }, { id: "ENROLLMENT", label: "New enrollment" }, { id: "ESCALATIONS", label: "Escalations" }, { id: "SERVICES", label: "Service requests" },
];
const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;
function label(value: unknown) { return String(value || "—").replaceAll("_", " "); }
function fmt(value?: string | null) { return value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString() : "Not recorded"; }
function patientName(task: CareQueueTask) { return `${task.patient.name.first} ${task.patient.name.last || ""}`.trim(); }
function priorityClass(priority: "HIGH" | "MEDIUM" | "LOW") { return priority.toLowerCase(); }
function priorityTitle(priority: "HIGH" | "MEDIUM" | "LOW") { return priority === "HIGH" ? "Act now" : priority === "MEDIUM" ? "Due soon" : "Planned"; }

export default function CareQueue() {
  const [q, setQ] = useState<CareQueue | null>(null);
  const [diagnoses, setDiagnoses] = useState<NewDiagnosisQueueItem[] | null>(null);
  const [referrals, setReferrals] = useState<ApexCareReferral[]>([]);
  const [reviews, setReviews] = useState<CoordinatorReview[] | null>(null);
  const [cases, setCases] = useState<ServiceCase[]>([]);
  const [escalations, setEscalations] = useState<CoordinatorEscalation[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [completing, setCompleting] = useState<string | null>(null);
  const [contacting, setContacting] = useState<string | null>(null);
  const [messaging, setMessaging] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      const [careQueue, diagnosisItems, serviceItems, reviewItems, escalationItems, referralItems] = await Promise.all([
        queue(), newDiagnosisQueue(), serviceCases(), coordinatorReviews(), coordinatorEscalations(), apexcareReferrals(),
      ]);
      setQ(careQueue); setDiagnoses(diagnosisItems); setCases(serviceItems); setReviews(reviewItems); setEscalations(escalationItems); setReferrals(referralItems);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load coordinator worklist."); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("filter");
    if (requested && FILTERS.some((item) => item.id === requested)) setFilter(requested as Filter);
  }, []);

  const referralByPatient = useMemo(() => new Map<string, ApexCareReferral>(referrals.map((item) => [item.patientId, item] as const)), [referrals]);
  const highTasks = useMemo(() => q?.tasks.filter((task) => task.priority === "HIGH") ?? [], [q]);
  const highReviews = useMemo(() => reviews?.filter((item) => item.priority === "HIGH") ?? [], [reviews]);
  const openCount = (q?.tasks.length ?? 0) + (reviews?.length ?? 0) + (diagnoses?.length ?? 0) + escalations.length + cases.length;
  const isUrgentEnrollment = (item: NewDiagnosisQueueItem) => {
    const referral = referralByPatient.get(item.patientId);
    const dueAt = referral?.staffEscalationDueAt || item.staffEscalationDueAt;
    return Boolean(dueAt && new Date(dueAt).getTime() < Date.now()) || Boolean(referral?.staffEscalatedAt || item.staffEscalatedAt);
  };
  const urgentEnrollmentCount = (diagnoses || []).filter(isUrgentEnrollment).length;
  const filterCounts: Record<Filter, number> = {
    ALL: openCount,
    URGENT: highTasks.length + highReviews.length + escalations.length + urgentEnrollmentCount,
    REVIEWS: reviews?.length ?? 0,
    CARE_TASKS: q?.tasks.length ?? 0,
    ENROLLMENT: diagnoses?.length ?? 0,
    ESCALATIONS: escalations.length,
    SERVICES: cases.length,
  };
  const normalizedSearch = search.trim().toLowerCase();
  const matches = (values: Array<string | undefined | null>) => !normalizedSearch || values.some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));

  const showCareTasks = filter === "ALL" || filter === "URGENT" || filter === "CARE_TASKS";
  const showReviews = filter === "ALL" || filter === "URGENT" || filter === "REVIEWS";
  const showEnrollment = filter === "ALL" || filter === "URGENT" || filter === "ENROLLMENT";
  const showEscalations = filter === "ALL" || filter === "URGENT" || filter === "ESCALATIONS";
  const showServices = filter === "ALL" || filter === "SERVICES";

  async function contactTask(taskId: string, outcome: "CONTACTED" | "UNANSWERED") {
    setContacting(taskId); setError(null);
    try { await updateCoordinatorTaskContact(taskId, outcome); await load(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to record contact outcome."); }
    finally { setContacting(null); }
  }
  async function messageTask(taskId: string) {
    setMessaging(taskId); setError(null);
    try { await sendCoordinatorTaskMessage(taskId); await load(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to queue the reminder. The message may require consent and a configured contact channel."); }
    finally { setMessaging(null); }
  }
  async function contactReview(reviewId: string, outcome: "CONTACTED" | "UNANSWERED") {
    setReviewAction(reviewId); setError(null);
    try { await updateCoordinatorReviewContact(reviewId, outcome); await load(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to record review contact outcome."); }
    finally { setReviewAction(null); }
  }
  async function messageReview(reviewId: string) {
    setReviewAction(reviewId); setError(null);
    try { await sendCoordinatorReviewMessage(reviewId); await load(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to queue the patient review reminder."); }
    finally { setReviewAction(null); }
  }
  async function finishTask(task: CareQueueTask) {
    setCompleting(task._id); setError(null);
    try { await completeCoordinatorTask(task._id); await load(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to complete task."); }
    finally { setCompleting(null); }
  }
  async function resolveEscalation(item: CoordinatorEscalation) {
    setResolving(item._id); setError(null);
    try { await resolveCoordinatorEscalation(item._id, "CONTACTED_AND_FOLLOWED_UP"); await load(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to resolve escalation."); }
    finally { setResolving(null); }
  }

  return <Gate><RoleGate allowed={["CLINIC_ADMIN", "CLINIC_COORDINATOR"]}><Shell title="Coordinator worklist" subtitle="One prioritized place for enrollment, patient contact, care tasks, exceptions and service handoffs.">
    <section className="hero glass page-enter coordinator-todo-hero"><div><div className="eyebrow">Operational work · Today</div><h2>Start with the most time-sensitive patient work.</h2><p>Use priority and due dates to decide what to do next. Contact patients, record outcomes, and complete only tasks the coordinator is authorized to close.</p></div><button className="secondary" onClick={() => void load(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? "button-spinner" : ""} /> {refreshing ? "Refreshing…" : "Refresh worklist"}</button></section>

    {error && <div className="card glass alert-error section page-enter"><b>Some work could not be completed.</b><p>{error}</p><button className="secondary" onClick={() => void load(true)}>Retry loading</button></div>}
    {!q || !diagnoses || !reviews ? <div className="grid g3 section">{[1,2,3].map((i) => <div className="card glass skeleton-stat" key={i} />)}</div> : <>
      <section className="grid g4 section coordinator-stat-grid">
        <div className="card glass stat"><ClipboardList size={18} /><small>Open work items</small><strong>{openCount}</strong><span className="muted">Across all coordinator queues</span></div>
        <div className="card glass stat"><AlertTriangle size={18} /><small>Act now</small><strong>{highTasks.length + highReviews.length + escalations.length + diagnoses.filter(isUrgentEnrollment).length}</strong><span className="muted">High-priority work and escalations</span></div>
        <div className="card glass stat"><CalendarClock size={18} /><small>Overdue visits</small><strong>{q.counts.overdueVisits}</strong><span className="muted">Care queue backend count</span></div>
        <div className="card glass stat"><FlaskConical size={18} /><small>Incomplete labs</small><strong>{q.counts.incompleteLabs}</strong><span className="muted">Lab workflow remains separate</span></div>
      </section>
      <section className="grid g4 section coordinator-stat-grid">
        <div className="card glass stat"><HeartPulse size={18} /><small>Missed care tasks</small><strong>{q.counts.missedCareTasks}</strong></div>
        <div className="card glass stat"><ClipboardList size={18} /><small>Pending reviews</small><strong>{q.counts.pendingReviews}</strong><span className="muted">Backend review count</span></div>
        <div className="card glass stat"><UserPlus size={18} /><small>New enrollment</small><strong>{diagnoses.length}</strong><span className="muted">Clinician referrals awaiting staff</span></div>
        <div className="card glass stat"><ShieldAlert size={18} /><small>Open escalations</small><strong>{escalations.length}</strong><span className="muted">{cases.length} service requests also open</span></div>
      </section>

      <section className="card glass section page-enter">
        <div className="section-head"><div><div className="eyebrow">Find the next task</div><h2>Worklist</h2><span className="muted">Filter by workflow or search patient, MRN, task, status or service reason.</span></div><span className="badge blue">{openCount} items</span></div>
        <div className="coordinator-filter-row">{FILTERS.map((item) => <button key={item.id} className={`coordinator-filter ${filter === item.id ? "active" : ""} ${filterCounts[item.id] ? "has-items" : ""}`} onClick={() => setFilter(item.id)}>{item.label}<span className="coordinator-filter-count">{filterCounts[item.id]}</span></button>)}</div>
        <label className="coordinator-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patient, MRN, task or status…" /><button type="button" onClick={() => setSearch("")} aria-label="Clear search" disabled={!search}><XCircle size={15} /></button></label>
      </section>

      {showCareTasks && <section className="card glass section page-enter coordinator-queue-section"><div className="section-head"><div><div className="eyebrow">Operational tasks</div><h2>Care tasks</h2><span className="muted">Includes visit, vitals, lab, medication, dietitian-session and follow-up tasks. Lab and medication tasks cannot be closed manually here.</span></div><span className="badge blue">{q.tasks.filter((task) => matches([patientName(task), task.patient.medicalRecordNumber, task.title, task.type, task.status, task.contactStatus])).length}</span></div>
        {PRIORITIES.map((priority) => { const list = q.tasks.filter((task) => (filter !== "URGENT" || task.priority === "HIGH") && task.priority === priority && matches([patientName(task), task.patient.medicalRecordNumber, task.title, task.type, task.status, task.contactStatus])); if (!list.length) return null; return <div className="task-priority-group" key={priority}><div className="task-priority-heading"><span className={`priority ${priorityClass(priority)}`}>{priority}</span><span>{priorityTitle(priority)}</span><b>{list.length}</b></div>{list.map((task) => <article className="coordinator-task-card" key={task._id}><div className={`coordinator-priority-dot ${task.priority.toLowerCase()}`} /><div className="coordinator-task-content"><div className="coordinator-work-title"><Link href={`/patients/${task.patient._id}`}><b>{patientName(task)}</b><ArrowUpRight size={13} /></Link><span className={`priority ${priorityClass(task.priority)}`}>{task.priority}</span></div><div className="coordinator-task-meta">{task.patient.medicalRecordNumber || "No MRN"} · {label(task.patient.condition)} · {label(task.patient.enrollmentStatus)} · {label(task.type)}</div><p>{task.title}</p><div className="coordinator-detail-chips"><span>{label(task.status)}</span><span>Contact: {label(task.contactStatus)}</span><span>Due: {fmt(task.dueAt)}</span>{task.lastContactedAt && <span>Last contact: {fmt(task.lastContactedAt)}</span>}{task.patient.preferredContactChannel && <span>Channel: {label(task.patient.preferredContactChannel)}</span>}</div>{task.contactNotes && <small className="muted">Contact note: {task.contactNotes}</small>}</div><div className="coordinator-task-actions"><Link className="secondary compact-action" href={`/patients/${task.patient._id}`}>Patient</Link>{task.patient.phone && <a className="secondary compact-action" href={`tel:${task.patient.phone}`}><Phone size={13} /> Call</a>}<button className="secondary compact-action" disabled={messaging === task._id || (!task.patient.phone && !task.patient.whatsapp)} onClick={() => void messageTask(task._id)}>{messaging === task._id ? <LoaderCircle size={13} className="button-spinner" /> : <MessageSquareText size={13} />}{messaging === task._id ? "Queueing…" : "Queue message"}</button>{(task.type === "FOLLOW_UP" || task.type === "VITALS") && <><button className="secondary compact-action" disabled={contacting === task._id} onClick={() => void contactTask(task._id, "CONTACTED")}><Check size={13} /> Contacted</button><button className="secondary compact-action danger-action" disabled={contacting === task._id} onClick={() => void contactTask(task._id, "UNANSWERED")}><UserRoundX size={13} /> Unanswered</button><button className="primary compact-action" disabled={completing === task._id} onClick={() => void finishTask(task)}>{completing === task._id ? "Saving…" : "Complete task"}</button></>}</div></article>)}</div>; })}
        {!q.tasks.some((task) => (filter !== "URGENT" || task.priority === "HIGH") && matches([patientName(task), task.patient.medicalRecordNumber, task.title, task.type, task.status, task.contactStatus])) && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No matching care tasks</b><span>Try another filter or clear your search.</span></div>}
      </section>}

      {showReviews && <section className="card glass section page-enter coordinator-queue-section"><div className="section-head"><div><div className="eyebrow">Patient contact workflow</div><h2>Patient reviews</h2><span className="muted">Priority is calculated by the backend from review due time. Complete the review in the dedicated review workspace after collecting the required information.</span></div><span className="badge blue">{reviews.filter((review) => (filter !== "URGENT" || review.priority === "HIGH") && matches([review.patient.name, review.patient.medicalRecordNumber, review.patient.condition, review.status, review.contactStatus, review.milestone.key])).length}</span></div>
        {PRIORITIES.map((priority) => { const list = reviews.filter((review) => (filter !== "URGENT" || review.priority === "HIGH") && review.priority === priority && matches([review.patient.name, review.patient.medicalRecordNumber, review.patient.condition, review.status, review.contactStatus, review.milestone.key])); if (!list.length) return null; return <div className="task-priority-group" key={priority}><div className="task-priority-heading"><span className={`priority ${priorityClass(priority)}`}>{priority}</span><span>{priorityTitle(priority)}</span><b>{list.length}</b></div>{list.map((review) => <article className="coordinator-task-card" key={review._id}><div className={`coordinator-priority-dot ${review.priority.toLowerCase()}`} /><div className="coordinator-task-content"><div className="coordinator-work-title"><Link href={`/patients/${review.patient._id}`}><b>{review.patient.name}</b><ArrowUpRight size={13} /></Link><span className={`badge ${review.contactStatus === "UNANSWERED" ? "danger" : review.contactStatus === "CONTACTED" ? "success" : "warn"}`}>{label(review.contactStatus)}</span></div><div className="coordinator-task-meta">{review.patient.medicalRecordNumber || "No MRN"} · Day {review.milestone.day} review · {label(review.patient.condition)}</div><p>{review.daysOverdue ? `${review.daysOverdue} day${review.daysOverdue === 1 ? "" : "s"} overdue` : `Due ${fmt(review.dueAt)}`}</p><div className="coordinator-detail-chips"><span>Status: {label(review.status)}</span><span>Milestone: {label(review.milestone.status)}</span><span>Contact: {label(review.contactStatus)}</span>{review.lastContactedAt && <span>Last contact: {fmt(review.lastContactedAt)}</span>}</div>{review.contactNotes && <small className="muted">Contact note: {review.contactNotes}</small>}</div><div className="coordinator-task-actions"><Link className="primary compact-action" href={`/reviews?reviewId=${encodeURIComponent(review._id)}`}>Open review <ArrowUpRight size={13} /></Link>{review.patient.phone && <a className="secondary compact-action" href={`tel:${review.patient.phone}`}><Phone size={13} /> Call</a>}<button className="secondary compact-action" disabled={reviewAction === review._id || (!review.patient.phone && !review.patient.whatsapp)} onClick={() => void messageReview(review._id)}>{reviewAction === review._id ? <LoaderCircle size={13} className="button-spinner" /> : <MessageSquareText size={13} />} Queue reminder</button><button className="secondary compact-action" disabled={reviewAction === review._id} onClick={() => void contactReview(review._id, "CONTACTED")}><Check size={13} /> Contacted</button><button className="secondary compact-action danger-action" disabled={reviewAction === review._id} onClick={() => void contactReview(review._id, "UNANSWERED")}><UserRoundX size={13} /> Unanswered</button></div></article>)}</div>; })}
        {!reviews.some((review) => (filter !== "URGENT" || review.priority === "HIGH") && matches([review.patient.name, review.patient.medicalRecordNumber, review.patient.condition, review.status, review.contactStatus, review.milestone.key])) && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No matching patient reviews</b><span>Review completion remains in the dedicated review workflow.</span></div>}
      </section>}

      {showEnrollment && <section className="card glass section page-enter coordinator-queue-section"><div className="section-head"><div><div className="eyebrow">New diagnosis → coordinator enrollment</div><h2>Enrollment handoffs</h2><span className="muted">Referral SLA and escalation timestamps are taken from the referral endpoint. Continue onboarding in the patient workspace.</span></div><span className="badge blue">{diagnoses.filter((item) => (filter !== "URGENT" || isUrgentEnrollment(item)) && matches([item.patientName, item.medicalRecordNumber, item.condition, item.assignedClinicianName, item.enrollmentStatus])).length}</span></div>
        {diagnoses.filter((item) => (filter !== "URGENT" || isUrgentEnrollment(item)) && matches([item.patientName, item.medicalRecordNumber, item.condition, item.assignedClinicianName, item.enrollmentStatus])).map((item) => { const referral = referralByPatient.get(item.patientId); const dueAt = referral?.staffEscalationDueAt || item.staffEscalationDueAt; const escalatedAt = referral?.staffEscalatedAt || item.staffEscalatedAt; const slaOverdue = Boolean(dueAt && new Date(dueAt).getTime() < Date.now()); const escalated = Boolean(escalatedAt); return <article className="coordinator-task-card" key={item.referralId || item.patientId}><div className={`coordinator-priority-dot ${slaOverdue || escalated ? "high" : "medium"}`} /><div className="coordinator-task-content"><div className="coordinator-work-title"><Link href={`/patients/${item.patientId}`}><b>{item.patientName}</b><ArrowUpRight size={13} /></Link><span className={`badge ${escalated || slaOverdue ? "danger" : "warn"}`}>{escalated ? "Escalated" : slaOverdue ? "SLA overdue" : "Awaiting staff"}</span></div><div className="coordinator-task-meta">{item.medicalRecordNumber || "No MRN"} · {label(item.condition)} · {label(item.enrollmentStatus)}</div><div className="coordinator-detail-chips"><span>Diagnosed: {fmt(item.diagnosedAt)}</span><span>Referred: {fmt(referral?.referredAt || item.referredAt)}</span><span>Staff escalation due: {fmt(dueAt)}</span>{escalatedAt && <span>Escalated at: {fmt(escalatedAt)}</span>}<span>Clinician: {item.assignedClinicianName || "Not recorded"}</span><span>Referral status: {label(referral?.status || "PENDING_STAFF")}</span></div></div><div className="coordinator-task-actions"><Link className="primary compact-action" href={`/patients/${item.patientId}`}>Open patient <ArrowUpRight size={13} /></Link><Link className="secondary compact-action" href="/enrollment">Enrollment queue</Link></div></article>; })}
        {!diagnoses.some((item) => (filter !== "URGENT" || isUrgentEnrollment(item)) && matches([item.patientName, item.medicalRecordNumber, item.condition, item.assignedClinicianName, item.enrollmentStatus])) && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No matching enrollment handoffs</b></div>}
      </section>}

      {showEscalations && <section className="card glass section page-enter coordinator-queue-section"><div className="section-head"><div><div className="eyebrow">Exception handling</div><h2>Open escalations</h2><span className="muted">Resolve only after the coordinator follow-up has actually occurred.</span></div><span className="badge danger">{escalations.length}</span></div>
        {escalations.filter((item) => matches([item.escalationType, item.reason, item.patientId, item.status, item.outcome])).map((item) => <article className="coordinator-task-card" key={item._id}><div className="coordinator-priority-dot high" /><div className="coordinator-task-content"><div className="coordinator-work-title"><b>{label(item.escalationType || "Patient follow-up")}</b><span className="badge danger">{label(item.status || "OPEN")}</span></div><p>{item.reason || "System-generated follow-up required."}</p><div className="coordinator-detail-chips"><span>Patient: {item.patientId ? item.patientId.slice(-6) : "Not linked"}</span><span>Created: {fmt(item.createdAt)}</span><span>Previous outcome: {label(item.outcome || "Not recorded")}</span></div></div><div className="coordinator-task-actions">{item.patientId && <Link className="secondary compact-action" href={`/patients/${item.patientId}`}>View patient</Link>}<button className="primary compact-action" disabled={resolving === item._id} onClick={() => void resolveEscalation(item)}>{resolving === item._id ? "Saving…" : "Resolve follow-up"}</button></div></article>)}
        {!escalations.some((item) => matches([item.escalationType, item.reason, item.patientId, item.status, item.outcome])) && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No matching escalations</b></div>}
      </section>}

      {showServices && <section className="card glass section page-enter coordinator-queue-section"><div className="section-head"><div><div className="eyebrow">ApexCare handoff</div><h2>Service requests</h2><span className="muted">Track request type, reason, status and assignment. Assignment and service-status changes use their own workflow.</span></div><span className="badge blue">{cases.filter((item) => matches([item.service, item.status, item.reason, item.patientId, item.requestedByUserId, item.assignedApexcareUserId])).length}</span></div>
        {cases.filter((item) => matches([item.service, item.status, item.reason, item.patientId, item.requestedByUserId, item.assignedApexcareUserId])).map((item) => <article className="coordinator-task-card" key={item._id}><div className="coordinator-priority-dot medium" /> <div className="coordinator-task-content"><div className="coordinator-work-title"><b>{item.service === "DIETITIAN" ? <><Utensils size={14} /> Dietitian service</> : <><Stethoscope size={14} /> Specialist service</>}</b><span className={`badge ${item.status === "SCHEDULED" ? "success" : item.status === "COMPLETED" ? "success" : item.status === "CANCELLED" ? "danger" : "warn"}`}>{label(item.status)}</span></div><div className="coordinator-task-meta">Patient {item.patientId.slice(-6)} · Requested by {item.requestedByUserId.slice(-6)} · Assigned {item.assignedApexcareUserId ? item.assignedApexcareUserId.slice(-6) : "Not assigned"}</div><p>{item.reason || "No service reason recorded."}</p><div className="coordinator-detail-chips"><span>Created: {fmt(item.createdAt)}</span><span>Request status: {label(item.status)}</span></div></div><div className="coordinator-task-actions"><Link className="secondary compact-action" href={`/patients/${item.patientId}`}>View patient</Link></div></article>)}
        {!cases.some((item) => matches([item.service, item.status, item.reason, item.patientId, item.requestedByUserId, item.assignedApexcareUserId])) && <div className="empty-state compact"><CheckCircle2 size={18} /><b>No matching service requests</b></div>}
      </section>}

      <section className="coordinator-safety-note"><ShieldAlert size={16} /><span>Coordinator boundary: contact patients, record outcomes, collect operational information and complete eligible FOLLOW_UP / VITALS tasks. Do not interpret labs, change treatment, or mark clinical/lab work complete from this screen. Automated reminders are queued by ApexCare; this does not confirm external delivery.</span></section>
    </>}
  </Shell></RoleGate></Gate>;
}
