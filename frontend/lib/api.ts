import type { CarePlan, CareQueue, CareQueueTask, Diagnosis, Me, OpdVisit, Patient, ServiceCase, VitalRecord, VisitAssist, VisitReview, VisitReviewAnswer, CreatePatientInput, NewDiagnosisQueueItem, ClinicalSignal, SubscriptionSummary, ClinicTeamMember, ApexCareReferral, ApexCareEnrollment, DietitianServiceCase, CoordinatorReview, PatientReviewAnswer, ApexCareCoordinatorCallOutcome, ApexCareGeneralHistory, SaveApexCareGeneralHistoryInput } from '@/types/api';

export const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');
export const SOCKET_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1').replace(/\/api\/v1\/?$/, '');
const MOCK = process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';

const mockPatient: Patient = {
  _id: 'demo-patient',
  medicalRecordNumber: 'APX-00128',
  name: { first: 'Arun', last: 'Kumar' },
  phone: '+91 98765 43210',
  enrollmentStatus: 'ACTIVE_CARE',
  status: 'ACTIVE',
  assignedClinicianId: 'demo-clinician',
  conditions: [{ code: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: '2026-08-10T10:00:00Z' }],
};

const mockVitals: VitalRecord[] = [
  { _id: 'v1', recordedAt: '2026-08-18T08:30:00Z', source: 'OPD', bloodPressure: { systolic: 132, diastolic: 84, pulse: 76 }, weightKg: 74.2 },
  { _id: 'v2', recordedAt: '2026-08-11T09:15:00Z', source: 'OPD', bloodPressure: { systolic: 138, diastolic: 88, pulse: 80 }, weightKg: 74.8 },
  { _id: 'v3', recordedAt: '2026-08-04T08:50:00Z', source: 'HOME', bloodPressure: { systolic: 142, diastolic: 91, pulse: 82 }, weightKg: 75.1 },
];

const mockCases: ServiceCase[] = [
  { _id: 'sc1', patientId: mockPatient._id, requestedByUserId: 'demo', service: 'DIETITIAN', status: 'REQUESTED', reason: 'Dietary counselling for blood pressure control.' },
  { _id: 'sc2', patientId: mockPatient._id, requestedByUserId: 'demo', service: 'ENDOCRINOLOGY', status: 'SCHEDULED', reason: 'Specialist review requested.' },
];

const mockPlan: CarePlan = {
  _id: 'cp1',
  condition: 'HYPERTENSION',
  status: 'ACTIVE',
  startDate: '2026-08-12T18:04:13Z',
  endDate: '2026-11-10T18:04:13Z',
  goals: [
    { title: 'Monitor blood pressure', target: 'Record BP according to the clinician-approved schedule' },
    { title: 'Complete scheduled follow-up', target: 'Attend planned OPD review' },
  ],
  version: 1,
};

async function wait<T>(value: T, delay = 150) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return value;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    typeof window !== 'undefined'
      ? localStorage.getItem('apexcare_token')
      : null;

  let response: Response;

  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch {
    const error = new Error(
      'Unable to connect to the ApexCare server. Please try again after sometime.'
    ) as Error & {
      code?: string;
      status?: number;
    };

    error.code = 'API_UNAVAILABLE';
    error.status = 0;

    throw error;
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = body?.error;

    if (
      typeof window !== 'undefined' &&
      error?.code === 'PASSWORD_CHANGE_REQUIRED'
    ) {
      window.location.replace('/account/password');
      throw new Error('PASSWORD_CHANGE_REQUIRED');
    }

    const err = new Error(
      error?.message || 'Request failed.'
    ) as Error & {
      code?: string;
      status?: number;
    };

    err.code = error?.code;
    err.status = response.status;

    throw err;
  }

  return body.data as T;
}

export async function login(email: string, password: string) {
  if (MOCK) return wait({ accessToken: 'demo-token', user: { id: 'demo', name: 'Dr. Maya Nair', email, roles: ['CLINICIAN'], organizationId: 'demo-org', mustChangePassword: false } satisfies Me & { organizationId: string; mustChangePassword?: boolean } });
  return request<{ accessToken: string; user: Me }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function updateEnrollmentProfile(patientId: string, input: { phone?: string; whatsapp?: string; preferredLanguage?: string; preferredContactChannel?: 'PHONE' | 'SMS' | 'WHATSAPP' | 'APP' }) {
  return request<Pick<Patient, '_id' | 'name' | 'phone' | 'whatsapp' | 'preferredLanguage' | 'preferredContactChannel' | 'enrollmentStatus'>>(`/patients/${encodeURIComponent(patientId)}/enrollment-profile`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function enrolPatient(
  patientId: string,
  input: {
    communicationConsent: true;
    consentMethod:
      | 'VERBAL'
      | 'WRITTEN'
      | 'DIGITAL';
    consentVersion: string;
  },
) {
  return request<{
    patientId: string;
    enrollmentStatus:
      | 'CARE_PLAN_REVIEW'
      | 'ENROLLED';
    assignedClinicianId?: string;
  }>(
    `/patients/${encodeURIComponent(
      patientId,
    )}/enrol`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}


export async function me() {
  if (MOCK) return wait<Me>({ id: 'demo-clinician', name: 'Dr. Maya Nair', email: 'maya@clinic.test', roles: ['CLINICIAN'], organizationId: 'demo-org', mustChangePassword: false });
  return request<Me>('/me');
}



export async function patientMe() {
  return request<{ patient: import('@/types/api').Patient; account: { id: string; name: string; email: string } }>('/patient/me');
}

export async function patientCare() {
  return request<import('@/types/api').PatientPortalData>('/patient/care');
}

export async function completePatientTask(taskId: string, status: 'COMPLETED' | 'SKIPPED' = 'COMPLETED') {
  return request<import('@/types/api').PatientPortalData['tasks'][number]>(`/patient/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function subscription() {
  return request<SubscriptionSummary>('/subscription');
}

export async function clinicTeam() {
  return request<ClinicTeamMember[]>('/clinic-team');
}

export async function apexCoordinatorQueue() {
  return request<ApexCareEnrollment[]>('/apexcare/coordinator-queue');
}

export async function apexReferrals() {
  return request<ApexCareReferral[]>('/apexcare/referrals');
}

export async function apexServiceCases() {
  return request<DietitianServiceCase[]>('/apexcare/service-cases');
}

export async function updateCoordinatorCall(enrollmentId: string, status: ApexCareCoordinatorCallOutcome) {
  return request<ApexCareEnrollment>(`/apexcare/enrollments/${encodeURIComponent(enrollmentId)}/coordinator-call`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/**
 * Read the general medical history attached to an ApexCare enrollment.
 *
 * Backend dependency: implement GET
 * /apexcare/enrollments/:enrollmentId/general-history.
 * The endpoint should return data: null when history has not been started.
 */
export async function apexGeneralMedicalHistory(enrollmentId: string) {
  return request<ApexCareGeneralHistory | null>(
    `/apexcare/enrollments/${encodeURIComponent(enrollmentId)}/general-history`,
  );
}

/**
 * Create or update the general medical history attached to an enrollment.
 *
 * Backend dependency: implement an authenticated, organization-scoped PUT
 * /apexcare/enrollments/:enrollmentId/general-history endpoint. The server,
 * not the browser, should derive the collector identity and history status.
 */
export async function saveApexGeneralMedicalHistory(
  enrollmentId: string,
  input: SaveApexCareGeneralHistoryInput,
) {
  return request<ApexCareGeneralHistory>(
    `/apexcare/enrollments/${encodeURIComponent(enrollmentId)}/general-history`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
}

export async function updateApexServiceCase(caseId: string, status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED', handoffSummary?: string) {
  return request<DietitianServiceCase>(`/apexcare/service-cases/${encodeURIComponent(caseId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, handoffSummary }),
  });
}

export async function patients() {
  if (MOCK) return wait([mockPatient]);
  return request<Patient[]>('/patients');
}

export async function createPatient(
  input: CreatePatientInput,
) {
  return request<Patient>(
    '/patients',
    {
      method: 'POST',

      body: JSON.stringify(input),
    },
  );
}

export async function newDiagnosisQueue() {
  return request<NewDiagnosisQueueItem[]>(
    '/care-queue/new-diagnoses',
  );
}


export async function visitAssist(patientId: string) {
  if (MOCK) {
    return wait<VisitAssist>({
      patientId,
      generatedAt: new Date().toISOString(),

      missingInformation: [
        {
          key: 'MEDICATION_ADHERENCE',
          label: 'Medication-taking pattern since the last visit',
          importance: 'HIGH',
        },
        {
          key: 'HOME_BP',
          label: 'Home blood-pressure monitoring frequency',
          importance: 'HIGH',
        },
        {
          key: 'SYMPTOMS',
          label: 'Current symptoms or new concerns',
          importance: 'HIGH',
        },
      ],

      questions: [
        {
          id: 'medication-adherence',
          topic: 'MEDICATION_ADHERENCE',
          question:
            'Have you missed any prescribed medicines since your last visit?',
          answerType: 'CHOICE',
          choices: [
            'No',
            '1–2 doses',
            'Several doses',
            'Not sure',
          ],
          reason:
            'Medication-taking information is not present in the available visit context.',
        },
        {
          id: 'home-bp-frequency',
          topic: 'HOME_BP',
          question:
            'How often have you checked your blood pressure at home since the last visit?',
          answerType: 'CHOICE',
          choices: [
            'Daily',
            '2–3 times a week',
            'Occasionally',
            'Not checking',
          ],
          reason:
            'Home-monitoring frequency is not reliably captured in the current record.',
        },
        {
          id: 'current-symptoms',
          topic: 'SYMPTOMS',
          question:
            'Have you had any new symptoms or concerns since your last visit?',
          answerType: 'YES_NO',
          choices: ['Yes', 'No'],
          reason:
            'Current symptom information is not available in the structured visit data.',
        },
      ],
    });
  }

  return request<VisitAssist>(
    `/patients/${encodeURIComponent(
      patientId,
    )}/hypertension/visit-assist`,
    {
      method: 'POST',
      body: '{}',
    },
  );
}



export async function patientById(id: string) {
  if (MOCK) return wait(mockPatient);
  return request<Patient>(`/patients/${encodeURIComponent(id)}`);
}

export async function diagnoses(id: string) {
  if (MOCK) return wait<Diagnosis[]>([{ _id: 'd1', condition: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: '2026-08-10T10:00:00Z', source: 'CLINICIAN' }]);
  return request<Diagnosis[]>(`/patients/${encodeURIComponent(id)}/diagnoses`);
}

export async function carePlanCommunications(id: string) {
  return request<Array<Record<string, unknown>>>(`/patients/${encodeURIComponent(id)}/care-plan-communications`);
}

export async function plans(id: string) {
  if (MOCK) return wait([mockPlan]);
  return request<CarePlan[]>(`/patients/${encodeURIComponent(id)}/care-plans`);
}

export async function patientVitals(id: string) {
  if (MOCK) return wait(mockVitals);
  return request<VitalRecord[]>(`/patients/${encodeURIComponent(id)}/vitals`);
}

export async function opd(id: string) {
  if (MOCK) return wait<OpdVisit[]>([{ _id: 'o1', visitAt: '2026-08-18T09:00:00Z', reason: 'Hypertension follow-up', notes: 'BP improving; continue current plan.' }]);
  return request<OpdVisit[]>(`/patients/${encodeURIComponent(id)}/opd-visits`);
}

export async function patientCases(id: string) {
  if (MOCK) return wait(mockCases);
  return request<ServiceCase[]>(`/patients/${encodeURIComponent(id)}/service-cases`);
}

export async function coordinatorReviews(status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' = 'OPEN') {
  if (MOCK) {
    return wait<CoordinatorReview[]>([]);
  }
  return request<CoordinatorReview[]>(`/coordinator/reviews?status=${status}`);
}

export async function updateCoordinatorReviewContact(reviewId: string, outcome: 'CONTACTED' | 'UNANSWERED', notes?: string) {
  if (MOCK) return wait<CoordinatorReview>({ _id: reviewId, patientId: mockPatient._id, carePlanId: mockPlan._id, executionId: 'demo-execution', milestoneId: 'demo-milestone', reviewKey: `demo-${reviewId}`, status: 'IN_PROGRESS', dueAt: new Date().toISOString(), priority: 'HIGH', daysOverdue: 0, contactStatus: outcome, questions: [], milestone: { key: 'DAY_30_MAJOR_CHECKPOINT', day: 30, dueAt: new Date().toISOString(), status: 'DUE' }, patient: { _id: mockPatient._id, name: 'Arun Kumar', medicalRecordNumber: mockPatient.medicalRecordNumber, enrollmentStatus: mockPatient.enrollmentStatus, condition: 'HYPERTENSION', phone: mockPatient.phone } });
  return request<CoordinatorReview>(`/coordinator/reviews/${encodeURIComponent(reviewId)}/contact`, { method: 'PATCH', body: JSON.stringify({ outcome, notes }) });
}

export async function sendCoordinatorReviewMessage(reviewId: string) {
  if (MOCK) return wait({ _id: `msg-${reviewId}`, status: 'READY', purpose: 'PATIENT_REVIEW_REMINDER', queued: true });
  return request<Record<string, unknown>>(`/coordinator/reviews/${encodeURIComponent(reviewId)}/message`, { method: 'POST', body: '{}' });
}

export async function recordCoordinatorVitals(patientId: string, input: {
  recordedAt?: string;
  source?: 'OPD' | 'HOME' | 'OTHER';
  bloodPressure?: { systolic?: number; diastolic?: number; pulse?: number };
  weightKg?: number;
  symptoms?: string[];
  notes?: string;
}) {
  if (MOCK) return wait({ _id: `v-${Date.now()}`, recordedAt: new Date().toISOString(), ...input });
  return request<VitalRecord>(`/patients/${encodeURIComponent(patientId)}/vitals`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function completeCoordinatorReview(patientId: string, reviewId: string, input: {
  answers: PatientReviewAnswer[];
  notes?: string;
  vitalsRecordId?: string;
}) {
  if (MOCK) return wait({ _id: reviewId, patientId, completedAt: new Date().toISOString(), ...input });
  return request<CoordinatorReview>(`/patients/${encodeURIComponent(patientId)}/care-plan-reviews/${encodeURIComponent(reviewId)}/complete`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function queue() {
  if (MOCK) return wait<CareQueue>({ counts: { overdueVisits: 3, incompleteLabs: 5, missedCareTasks: 2, pendingReviews: 2 }, overdueVisits: [], incompleteLabs: [], missedCareTasks: [], tasks: [], reviews: [] });
  return request<CareQueue>('/care-queue');
}

export async function completeCoordinatorTask(taskId: string) {
  if (MOCK) return wait<CareQueueTask>({
    _id: taskId, patientId: mockPatient._id, carePlanId: mockPlan._id, type: 'FOLLOW_UP', title: 'Coordinator follow-up',
    dueAt: new Date().toISOString(), status: 'COMPLETED', contactStatus: 'CONTACTED', priority: 'MEDIUM', patient: { _id: mockPatient._id, name: mockPatient.name, medicalRecordNumber: mockPatient.medicalRecordNumber, enrollmentStatus: mockPatient.enrollmentStatus, condition: 'HYPERTENSION' },
  });
  return request<CareQueueTask>(`/coordinator/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'COMPLETED' }) });
}

export async function updateCoordinatorTaskContact(taskId: string, outcome: 'CONTACTED' | 'UNANSWERED', notes?: string) {
  if (MOCK) return wait({ _id: taskId, contactStatus: outcome, lastContactedAt: new Date().toISOString(), contactNotes: notes });
  return request<CareQueueTask>(`/coordinator/tasks/${encodeURIComponent(taskId)}/contact`, { method: 'PATCH', body: JSON.stringify({ outcome, notes }) });
}

export async function sendCoordinatorTaskMessage(taskId: string) {
  if (MOCK) return wait({ _id: `msg-${taskId}`, status: 'READY', purpose: 'CARE_TASK_REMINDER', queued: true });
  return request<Record<string, unknown>>(`/coordinator/tasks/${encodeURIComponent(taskId)}/message`, { method: 'POST', body: '{}' });
}

export async function serviceCases() {
  if (MOCK) return wait(mockCases);
  return request<ServiceCase[]>('/service-cases');
}

export async function serviceCaseById(id: string) {
  if (MOCK) return wait(mockCases.find((item) => item._id === id) || mockCases[0]);
  return request<ServiceCase>(`/service-cases/${encodeURIComponent(id)}`);
}

export async function progressSummary(id: string) {
  if (MOCK) return wait({ latestBloodPressure: mockVitals[0].bloodPressure, recentReadings: mockVitals, trend: 'IMPROVING', attention: [] });
  return request<Record<string, unknown>>(`/patients/${encodeURIComponent(id)}/hypertension/progress-summary`);
}

export async function generateDraft(id: string) {
  if (MOCK) return wait({ _id: 'draft-demo', status: 'QUEUED' });
  return request(`/patients/${encodeURIComponent(id)}/hypertension/care-plan-drafts`, { method: 'POST', body: '{}' });
}

export async function drafts(id: string) {
  if (MOCK) return wait([{ _id: 'draft-demo', status: 'QUEUED', createdAt: new Date().toISOString(), plan: { goals: [{ title: 'Monitor blood pressure', target: 'Record BP weekly' }], tasks: [] } }]);
  return request<Array<Record<string, unknown>>>(`/patients/${encodeURIComponent(id)}/hypertension/care-plan-drafts`);
}

export async function approveDraft(patientId: string, draftId: string) {
  if (MOCK) return wait(mockPlan);
  return request<CarePlan>(`/patients/${encodeURIComponent(patientId)}/hypertension/care-plan-drafts/${encodeURIComponent(draftId)}/approve`, { method: 'PATCH', body: '{}' });
}

export async function rejectDraft(patientId: string, draftId: string) {
  if (MOCK) return wait({ status: 'REJECTED' });
  return request(`/patients/${encodeURIComponent(patientId)}/hypertension/care-plan-drafts/${encodeURIComponent(draftId)}/reject`, { method: 'PATCH', body: '{}' });
}

export async function saveVisitReview(
  patientId: string,
  review: {
    visitAt?: string;
    answers: PatientReviewAnswer[];
  },
) {
  return request<VisitReview>(
    `/patients/${encodeURIComponent(
      patientId,
    )}/hypertension/visit-reviews`,
    {
      method: 'POST',
      body: JSON.stringify(review),
    },
  );
}

export async function getVisitReviews(
  patientId: string,
) {
  return request<VisitReview[]>(
    `/patients/${encodeURIComponent(
      patientId,
    )}/hypertension/visit-reviews`,
  );
}

export async function labDocuments(id: string) {
  return request<import('@/types/api').LabDocument[]>(`/patients/${encodeURIComponent(id)}/lab-documents`);
}

export async function labResults(id: string, documentId: string) {
  return request<{ document: import('@/types/api').LabDocument; results: import('@/types/api').LabResult[] }>(`/patients/${encodeURIComponent(id)}/lab-documents/${encodeURIComponent(documentId)}/results`);
}

export async function labInterpretation(id: string, documentId: string) {
  return request<import('@/types/api').LabInterpretation>(`/patients/${encodeURIComponent(id)}/lab-documents/${encodeURIComponent(documentId)}/interpretation`);
}

export async function reviewLabInterpretation(id: string, documentId: string, input: { decision: 'APPROVED' | 'MODIFIED' | 'REJECTED'; clinicianApprovedSummary?: string }) {
  return request<import('@/types/api').LabInterpretation>(`/patients/${encodeURIComponent(id)}/lab-documents/${encodeURIComponent(documentId)}/interpretation/review`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function clinicalSignals(patientId?: string) {
  const query = patientId ? `?patientId=${encodeURIComponent(patientId)}` : '';
  return request<import('@/types/api').ClinicalSignal[]>(`/clinical-signals${query}`);
}

export async function reviewClinicalSignal(signalId: string, input: { decision: 'ACTION_REQUIRED' | 'REVIEWED' | 'DISMISSED'; notes?: string }) {
  return request<import('@/types/api').ClinicalSignal>(`/clinical-signals/${encodeURIComponent(signalId)}/review`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function medications(id: string) {
  return request<import('@/types/api').Medication[]>(`/patients/${encodeURIComponent(id)}/medications`);
}

export async function carePlanExecution(id: string, carePlanId: string) {
  return request<import('@/types/api').CarePlanExecution>(`/patients/${encodeURIComponent(id)}/care-plans/${encodeURIComponent(carePlanId)}/execution`);
}

export async function transitionMilestone(id: string, carePlanId: string, milestoneId: string, action: 'COMPLETE' | 'SKIP') {
  return request<Record<string, unknown>>(`/patients/${encodeURIComponent(id)}/care-plans/${encodeURIComponent(carePlanId)}/execution/milestones/${encodeURIComponent(milestoneId)}`, { method: 'PATCH', body: JSON.stringify({ action }) });
}


export async function prescriptionDocuments(id: string) {
  return request<import('@/types/api').PrescriptionDocument[]>(`/patients/${encodeURIComponent(id)}/prescription-documents`);
}

export async function medicationDrafts(id: string, documentId: string) {
  return request<import('@/types/api').MedicationDraft[]>(`/patients/${encodeURIComponent(id)}/prescription-documents/${encodeURIComponent(documentId)}/medication-drafts`);
}


async function uploadBinary<T>(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('apexcare_token') : null;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      body,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
  } catch {
    const error = new Error('Unable to connect to the ApexCare server.') as Error & { code?: string; status?: number };
    error.code = 'API_UNAVAILABLE'; error.status = 0; throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.error?.message || 'Request failed.') as Error & { code?: string; status?: number };
    err.code = payload?.error?.code; err.status = response.status; throw err;
  }
  return payload.data as T;
}

export async function uploadPrescription(patientId: string, file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read the prescription image.'));
    reader.readAsDataURL(file);
  });
  return request<{ prescriptionDocument: import('@/types/api').PrescriptionDocument; medicationDraft: import('@/types/api').MedicationDraft; analysisStatus: string; jobId: string }>(
    `/patients/${encodeURIComponent(patientId)}/prescription-documents/upload`,
    { method: 'POST', body: JSON.stringify({ source: 'IMAGE', fileName: file.name || 'prescription.jpg', mimeType: file.type, imageBase64: dataUrl }) },
  );
}

export async function submitMedicationDraft(patientId: string, documentId: string, draftId: string, medications: NonNullable<import('@/types/api').MedicationDraft['medications']>) {
  return request(`/patients/${encodeURIComponent(patientId)}/prescription-documents/${encodeURIComponent(documentId)}/medication-drafts/${encodeURIComponent(draftId)}/submit`, { method: 'POST', body: JSON.stringify({ medications }) });
}

export async function finalizeMedicationDraft(patientId: string, documentId: string, draftId: string, reason?: string) {
  return request(`/patients/${encodeURIComponent(patientId)}/prescription-documents/${encodeURIComponent(documentId)}/medication-drafts/${encodeURIComponent(draftId)}/finalize`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function clinicalReviewQueue() {
  return request<import('@/types/api').ClinicalReviewCase[]>('/clinical-review-queue');
}

export async function clinicalReviewCase(caseId: string) {
  return request<Record<string, unknown>>(`/clinical-review-cases/${encodeURIComponent(caseId)}`);
}

export async function decideClinicalReview(caseId: string, input: { decision: 'APPROVE' | 'REJECT' | 'ESCALATE_TO_APEXCARE'; reason?: string }) {
  return request(`/clinical-review-cases/${encodeURIComponent(caseId)}/decision`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function coordinatorEscalations(status: 'OPEN' | 'RESOLVED' = 'OPEN') {
  return request<import('@/types/api').CoordinatorEscalation[]>(`/coordinator/escalations?status=${status}&limit=100`);
}

export async function resolveCoordinatorEscalation(caseId: string, outcome: string, notes?: string) {
  return request(`/coordinator/escalations/${encodeURIComponent(caseId)}/resolve`, { method: 'PATCH', body: JSON.stringify({ outcome, notes }) });
}


export async function notifications(unreadOnly = false, limit = 30) {
  return request<import('@/types/api').NotificationList>(`/notifications?unreadOnly=${unreadOnly ? 'true' : 'false'}&limit=${limit}`);
}

export async function markNotificationRead(notificationId: string) {
  return request<import('@/types/api').AppNotification>(`/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'PATCH' });
}

export async function markAllNotificationsRead() {
  return request<{ modified: number }>('/notifications/read-all', { method: 'PATCH' });
}
