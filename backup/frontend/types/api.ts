export type Patient = {
  _id: string;
  medicalRecordNumber?: string;
  name: { first: string; last?: string };
  dateOfBirth?: string;
  sexAtBirth?: 'FEMALE' | 'MALE' | 'INTERSEX' | 'NOT_RECORDED';
  phone?: string;
  whatsapp?: string;
  preferredLanguage?: string;
  preferredContactChannel?: 'PHONE' | 'SMS' | 'WHATSAPP' | 'APP';
  contactProfileLastUpdatedAt?: string;
  contactProfileLastUpdatedByUserId?: string;
  assignedClinicianId?: string;
  assignedClinicianName?: string | null;
  enrollmentStatus?: string;
  status?: string;
  conditions?: Array<{ code: string; status?: string; diagnosedAt?: string }>;
};

export type CreatePatientInput = {
  medicalRecordNumber: string;

  name: {
    first: string;
    last?: string;
  };

  dateOfBirth?: string;

  sexAtBirth?:
    | 'FEMALE'
    | 'MALE'
    | 'INTERSEX'
    | 'NOT_RECORDED';

  phone?: string;

  preferredLanguage?: string;

  preferredContactChannel?:
    | 'PHONE'
    | 'SMS'
    | 'WHATSAPP'
    | 'APP';

  assignedClinicianId: string;

  diagnosis: {
    condition: 'HYPERTENSION';
    diagnosedAt?: string;
    notes?: string;
  };
};

export type Diagnosis = {
  _id: string;
  condition: string;
  status: string;
  diagnosedAt: string;
  source?: string;
};

export type PatientReviewAnswer = {
  questionId: string;
  topic: string;
  question: string;
  answer?: string;
};

export type VisitReviewAnswer = {
  questionId: string;
  topic:
    | 'MEDICATION_ADHERENCE'
    | 'HOME_BP'
    | 'SYMPTOMS'
    | 'LABS'
    | 'LIFESTYLE'
    | 'CARE_PLAN'
    | 'FOLLOW_UP';
  question: string;
  answer?: string;
};

export type VisitReview = {
  _id: string;
  patientId: string;
  coordinatorUserId: string;
  visitAt: string;
  assistantRunAt: string;
  completedAt?: string;
  answers: VisitReviewAnswer[];
};

export type CarePlan = {
  _id: string;
  condition: string;
  status: string;
  startDate: string;
  endDate?: string;
  goals: Array<{ title: string; target: string; unit?: string }>;
  version: number;
  approvedAt?: string;
};
export type VitalRecord = {
  _id: string;
  recordedAt: string;
  source?: string;
  bloodPressure?: { systolic?: number; diastolic?: number; pulse?: number };
  bloodSugar?: { value: number; type: 'FASTING' | 'POST_PRANDIAL' | 'RANDOM' | 'HBA1C'; unit: 'MG_DL' | 'PERCENT' };
  weightKg?: number;
  symptoms?: string[];
  notes?: string;
};
export type OpdVisit = {
  _id: string;
  visitAt: string;
  clinicianId?: string;
  reason?: string;
  assessment?: string;
  planAdjustment?: string;
  carePlanId?: string;
  vitalsRecordId?: string;
  notes?: string; // legacy display fallback for older records
};
export type ServiceCase = {
  _id: string;
  service: "DIETITIAN" | "ENDOCRINOLOGY";
  status: "REQUESTED" | "ASSIGNED" | "SCHEDULED" | "COMPLETED" | "CANCELLED";
  reason: string;
  patientId: string;
  requestedByUserId: string;
  assignedApexcareUserId?: string;
  createdAt?: string;
};
export type CoordinatorReview = {
  _id: string;
  patientId: string;
  carePlanId: string;
  executionId: string;
  milestoneId: string;
  reviewKey: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED';
  dueAt: string;
  startedAt?: string;
  completedAt?: string;
  contactStatus: 'NOT_CONTACTED' | 'CONTACTED' | 'UNANSWERED' | 'MESSAGE_QUEUED';
  lastContactedAt?: string;
  contactNotes?: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  daysOverdue: number;
  questions: Array<{
    questionId: string;
    topic: string;
    question: string;
  }>;
  milestone: {
    key: string;
    day: number;
    dueAt: string;
    status: string;
  };
  patient: {
    _id: string;
    name: string;
    medicalRecordNumber?: string;
    enrollmentStatus?: string;
    condition?: string | null;
    phone?: string | null;
    whatsapp?: string | null;
    preferredContactChannel?: string;
  };
};

export type CoordinatorReviewContactStatus = CoordinatorReview['contactStatus'];

export type CareQueueTask = {
  _id: string;
  patientId: string;
  carePlanId: string;
  executionId?: string;
  milestoneId?: string;
  taskKey?: string;
  type: 'OPD_VISIT' | 'VITALS' | 'LAB' | 'MEDICATION' | 'DIETITIAN_SESSION' | 'FOLLOW_UP';
  title: string;
  dueAt: string;
  status: 'PENDING' | 'COMPLETED' | 'SKIPPED' | 'OVERDUE';
  completedAt?: string;
  contactStatus: 'NOT_CONTACTED' | 'CONTACTED' | 'UNANSWERED' | 'MESSAGE_QUEUED';
  lastContactedAt?: string;
  contactNotes?: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  patient: {
    _id: string;
    name: { first: string; last?: string };
    medicalRecordNumber?: string;
    enrollmentStatus?: string;
    condition?: string | null;
    phone?: string | null;
    whatsapp?: string | null;
    preferredContactChannel?: string;
  };
};

export type CareQueue = {
  counts: {
    overdueVisits: number;
    incompleteLabs: number;
    missedCareTasks: number;
    pendingReviews: number;
  };
  overdueVisits: CareQueueTask[];
  incompleteLabs: CareQueueTask[];
  missedCareTasks: CareQueueTask[];
  tasks: CareQueueTask[];
  reviews: CoordinatorReview[];
};

export type NewDiagnosisQueueItem = {
  referralId?: string;
  patientId: string;
  medicalRecordNumber?: string;
  patientName: string;
  condition?: string;
  diagnosedAt: string | null;
  referredAt?: string;
  staffEscalationDueAt?: string;
  staffEscalatedAt?: string | null;

  enrollmentStatus:
    | 'NOT_ENROLLED'
    | 'ENROLLED'
    | 'CARE_PLAN_REVIEW'
    | 'ACTIVE_CARE'
    | 'INACTIVE';

  assignedClinicianId?: string;
  assignedClinicianName?: string | null;
};

export type VisitAssistQuestion = {
  id: string;
  topic:
    | 'MEDICATION_ADHERENCE'
    | 'HOME_BP'
    | 'SYMPTOMS'
    | 'LABS'
    | 'LIFESTYLE'
    | 'CARE_PLAN'
    | 'FOLLOW_UP';

  question: string;
  answerType: 'TEXT' | 'YES_NO' | 'CHOICE';
  choices?: string[];
  reason: string;
};

export type VisitAssist = {
  patientId: string;
  generatedAt: string;

  missingInformation: Array<{
    key: string;
    label: string;
    importance: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;

  questions: VisitAssistQuestion[];
};


export type Role =
  | "CLINIC_ADMIN"
  | "CLINICIAN"
  | "CLINIC_COORDINATOR"
  | "APEXCARE_COORDINATOR"
  | "APEXCARE_DIETITIAN"
  | "APEXCARE_SPECIALIST"
  | "APEXCARE_DOCTOR"
  | "PLATFORM_ADMIN"
  | "PATIENT";
export type Me = {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  organizationId: string;
  mustChangePassword?: boolean;
};


export type LabDocument = {
  _id: string;
  fileName: string;
  status?: string;
  extractionStatus?: string;
  structuringStatus?: string;
  interpretationStatus?: string;
  structuredResultCount?: number;
  uploadedAt?: string;
  createdAt?: string;
};

export type LabResult = {
  _id: string;
  testName: string;
  valueNumber?: number;
  valueText: string;
  unit?: string;
  referenceLow?: number;
  referenceHigh?: number;
  referenceRangeText?: string;
  abnormalFlag: 'HIGH' | 'LOW' | 'NORMAL' | 'UNKNOWN';
  extractionConfidence?: number;
};

export type LabInterpretation = {
  _id: string;
  clinicianSummary: string;
  patientSummary: string;
  suggestedDiscussionPoints?: string[];
  urgentReview?: boolean;
  confidence?: number;
  status?: string;
  clinicianReviewStatus: 'PENDING' | 'APPROVED' | 'MODIFIED' | 'REJECTED';
  clinicianApprovedSummary?: string;
  patientApprovedSummary?: string;
  patientLanguage?: string;
  provider?: string;
  model?: string;
  createdAt?: string;
};

export type ClinicalSignal = {
  _id: string;
  patientId: string;
  sourceType: 'LAB_INTERPRETATION' | 'ADHERENCE_REVIEW';
  kind: 'URGENT_LAB' | 'ABNORMAL_LAB' | 'LOW_ADHERENCE' | 'REPEATED_MISSED_TASKS';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'OPEN' | 'REVIEWED' | 'ACTION_REQUIRED' | 'DISMISSED';
  summary: string;
  evidence?: unknown;
  createdAt?: string;
};

export type Medication = {
  _id: string;
  name: string;
  strength?: string;
  dose?: string;
  route?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
  status: 'ACTIVE' | 'DISCONTINUED';
  startedAt?: string;
  discontinuedAt?: string;
};

export type CarePlanExecution = {
  execution: Record<string, any>;
  milestones: Array<Record<string, any>>;
  tasks: Array<Record<string, any>>;
};


export type PrescriptionDocument = {
  _id: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  status?: 'CAPTURED' | 'ANALYZING' | 'VERIFICATION_REQUIRED' | 'VERIFIED' | 'NEEDS_CLINICAL_REVIEW' | string;
  analysisStatus?: 'NOT_STARTED' | 'PENDING' | 'COMPLETED' | 'FAILED' | string;
  clinicalReviewReason?: string;
  capturedAt?: string;
  createdAt?: string;
};

export type MedicationDraft = {
  _id: string;
  status?: 'DRAFT' | 'VERIFICATION_REQUIRED' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | string;
  clinicalReviewRequired?: boolean;
  clinicalReviewReason?: string;
  rawText?: string;
  medications?: Array<{
    name: string;
    strength?: string;
    dose?: string;
    route?: string;
    frequency?: string;
    duration?: string;
    instructions?: string;
    confidence?: number;
    sourceText?: string;
  }>;
  createdAt?: string;
};

export type PrescriptionOcrStatus = {
  configured: boolean;
  medicationStructuringConfigured: boolean;
  independentVerificationConfigured: boolean;
  provider: 'paddleocr-vl' | 'openai-compatible' | 'openai-compatible-fallback' | null;
  timeoutMs: number;
};


export type ClinicalReviewCase = {
  _id: string;
  patientId: string;
  prescriptionDocumentId: string;
  medicationDraftId: string;
  clinicClinicianId: string;
  status: 'CLINICIAN_REVIEW' | 'APEXCARE_REVIEW' | string;
  reason?: string;
  reasonCode?: string;
  clinicReviewDueAt?: string;
  createdAt?: string;
};

export type CoordinatorEscalation = {
  _id: string;
  patientId?: string;
  reason?: string;
  status?: 'OPEN' | 'RESOLVED' | string;
  createdAt?: string;
  escalationType?: string;
  outcome?: string;
};


export type SubscriptionSummary = {
  planCode: string;
  status: string;
  activePatientLimit: number;
  activePatientCount: number;
  availablePatientSlots: number;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
};

export type ClinicTeamMember = {
  _id: string;
  name: string;
  email: string;
  roles: Role[];
  status: string;
  mustChangePassword?: boolean;
  createdAt?: string;
};

export type ApexCareReferral = {
  _id: string;
  patientId: string;
  clinicOrganizationId?: string;
  condition?: string;
  status?: string;
  referredAt?: string;
  staffEscalationDueAt?: string;
  staffEscalatedAt?: string | null;
};

export type ApexCareEnrollment = {
  _id: string;
  patientId: string;
  clinicOrganizationId?: string;
  status?: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'ENDED' | string;
  enrolledAt?: string;
  coordinatorCallStatus?: 'PENDING' | 'CONTACTED' | 'NO_ANSWER' | 'ESCALATED' | string;
  coordinatorCallDueAt?: string;
  coordinatorCalledAt?: string;
  dietitianAssessmentStatus?: 'PENDING' | 'COMPLETED' | string;
  carePlanGenerationStatus?: 'NOT_STARTED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | string;
  carePlanGenerationAttempt?: number;
  carePlanGenerationError?: string | null;
  carePlanDraftId?: string;
  carePlanGenerationJobId?: string | null;
  patient?: {
    _id: string;
    name: { first: string; last?: string };
    phone?: string | null;
    whatsapp?: string | null;
    dateOfBirth?: string | null;
    sexAtBirth?: 'FEMALE' | 'MALE' | 'INTERSEX' | 'NOT_RECORDED' | null;
    preferredLanguage?: string;
    conditions?: Array<{ code: string; status?: string; diagnosedAt?: string }>;
  };
  assessment?: {
    remarks: string;
    assessmentData?: Record<string, unknown>;
    completedAt?: string | null;
    dietitianUserId?: string;
  } | null;
};

export type DietitianServiceCase = {
  _id: string;
  patientId: string;
  service: 'DIETITIAN' | 'ENDOCRINOLOGY' | string;
  status: 'REQUESTED' | 'ASSIGNED' | 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | string;
  reason?: string;
  assignedApexcareUserId?: string;
  createdAt?: string;
};


export type PatientPortalData = {
  patient: Patient;
  plan: CarePlan | null;
  tasks: Array<{ _id: string; type: string; title: string; dueAt: string; status: 'PENDING' | 'COMPLETED' | 'SKIPPED' | 'OVERDUE'; completedAt?: string }>;
  pendingTasks: Array<{ _id: string; type: string; title: string; dueAt: string; status: 'PENDING' | 'OVERDUE' }>;
  completedTasks: number;
  totalTasks: number;
  medications: Medication[];
  labSummaries: Array<{ _id: string; labDocumentId: string; patientApprovedSummary: string; patientLanguage?: string; clinicianReviewStatus: string; createdAt?: string }>;
  services: ServiceCase[];
};


export type AppNotification = {
  _id: string;
  notificationKey: string;
  organizationId: string;
  recipientUserId: string;
  eventType: string;
  title: string;
  body: string;
  href?: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  readAt?: string | null;
  createdAt: string;
};

export type NotificationList = {
  items: AppNotification[];
  unreadCount: number;
};
