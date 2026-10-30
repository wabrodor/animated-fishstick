export type Patient = {
  _id: string;
  medicalRecordNumber?: string;
  name: { first: string; last?: string };
  dateOfBirth?: string;
  ageAtRegistration?: number;
  phone?: string;
  whatsapp?: string;
  preferredLanguage?: string;
  preferredContactChannel?: 'PHONE' | 'SMS' | 'WHATSAPP' | 'APP';
  assignedClinicianId?: string;
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

  ageAtRegistration: number;

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
  weightKg?: number;
};
export type OpdVisit = {
  _id: string;
  visitAt: string;
  reason?: string;
  notes?: string;
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
  patientId: string;

  medicalRecordNumber?: string;

  patientName: string;

  diagnosedAt: string | null;

  enrollmentStatus:
    | 'NOT_ENROLLED'
    | 'ENROLLED'
    | 'CARE_PLAN_REVIEW'
    | 'ACTIVE_CARE'
    | 'INACTIVE';

  assignedClinicianId?: string;
  assignedClinicianName?: string | null;
  condition?: string;
  referralId?: string;
  referredAt?: string;
  staffEscalationDueAt?: string;
  staffEscalatedAt?: string | null;
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
  processingStage?: string;
  processingVersion?: number;
  processingAttempts?: number;
  safeLastErrorCode?: string;
  extractionWarningCode?: string;
  ocrEngine?: string;
  ocrEngineVersion?: string;
  ocrWarningCode?: string;
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
  reviewStatus?: 'UNVERIFIED' | 'VERIFIED' | 'SUPERSEDED';
  sourceText?: string;
  sourcePage?: number;
  extractionMethod?: string;
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
  status?: string;
  analysisStatus?: string;
  clinicalReviewReason?: string;
  capturedAt?: string;
  createdAt?: string;
};

export type MedicationDraft = {
  _id: string;
  status?: string;
  clinicalReviewRequired?: boolean;
  medications?: Array<{ name: string; strength?: string; dose?: string; route?: string; frequency?: string; duration?: string; instructions?: string }>;
  createdAt?: string;
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
  condition?: string;
  status?: string;
  referredAt?: string;
  staffEscalationDueAt?: string;
  staffEscalatedAt?: string | null;
};

export type ApexCareCoordinatorCallStatus =
  | 'PENDING'
  | 'CONTACTED'
  | 'NO_ANSWER'
  | 'ESCALATED';

/** Outcomes a coordinator is allowed to submit to the call-outcome endpoint. */
export type ApexCareCoordinatorCallOutcome = Exclude<
  ApexCareCoordinatorCallStatus,
  'PENDING'
>;

export type ApexCareGeneralHistoryStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'RECORDED';

export type ApexCareGeneralHistorySection =
  | 'PAST_MEDICAL'
  | 'FAMILY'
  | 'SOCIAL'
  | 'ALLERGIES'
  | 'REPRODUCTIVE'
  | 'PRIOR_INVESTIGATIONS';

/**
 * Yes / No / Unknown / Declined is intentionally explicit. Do not use a
 * boolean here: Unknown and Declined are clinically and operationally distinct.
 */
export type ApexCareGeneralHistoryAnswerValue =
  | 'YES'
  | 'NO'
  | 'UNKNOWN'
  | 'DECLINED';

export type ApexCareGeneralHistoryAnswer = {
  questionId: string;
  section: ApexCareGeneralHistorySection;
  question: string;
  answer: ApexCareGeneralHistoryAnswerValue;
  /** Conditional details collected only when the question requires follow-up. */
  details?: string;
};

export type ApexCareGeneralHistory = {
  _id: string;
  enrollmentId: string;
  patientId: string;
  status: 'IN_PROGRESS' | 'RECORDED';
  questionnaireVersion: string;
  answers: ApexCareGeneralHistoryAnswer[];
  notes?: string;
  collectedByUserId?: string;
  collectedAt?: string;
  recordedAt?: string;
  events?: Array<{
    eventType: 'DRAFT_SAVED' | 'RECORDED';
    actorUserId: string;
    actorRole: 'APEXCARE_COORDINATOR';
    createdAt: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
};

/** Read-only history snapshot returned to the assigned clinic clinician. */
export type ApexCareGeneralHistoryPatientSnapshot = {
  _id: string;
  patientId: string;
  status: 'RECORDED';
  source: 'APEXCARE_COORDINATOR';
  questionnaireVersion: string;
  answers: ApexCareGeneralHistoryAnswer[];
  notes?: string;
  collectedAt?: string;
  collectedByName?: string;
  recordedAt?: string;
  updatedAt?: string;
};

/** Client input; collector identity and persisted status are assigned by the API. */
export type SaveApexCareGeneralHistoryInput = {
  questionnaireVersion: string;
  answers: ApexCareGeneralHistoryAnswer[];
  notes?: string;
  /** True when the coordinator is recording the completed intake as history. */
  record?: boolean;
};

export type ApexCareEnrollment = {
  _id: string;
  patientId: string;
  clinicOrganizationId?: string;
  coordinatorCallStatus?: ApexCareCoordinatorCallStatus;
  coordinatorCallDueAt?: string;
  coordinatorCalledAt?: string;
  generalHistoryId?: string | null;
  generalHistoryStatus?: ApexCareGeneralHistoryStatus;
  generalHistoryUpdatedAt?: string | null;
  generalHistoryRecordedAt?: string | null;
  generalHistoryCompletedAt?: string | null; // legacy compatibility only
  dietitianAssessmentStatus?: 'PENDING' | 'COMPLETED';
  carePlanGenerationStatus?: string;
  carePlanGenerationJobId?: string | null;
  carePlanGenerationError?: string | null;
  carePlanDraftId?: string;
  status?: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'ENDED';
  enrolledAt?: string;
  createdAt?: string;
  updatedAt?: string;
  patient?: Pick<Patient, '_id' | 'name' | 'conditions' | 'medicalRecordNumber' | 'phone' | 'preferredContactChannel' | 'preferredLanguage'>;
  assessment?: { _id?: string; remarks?: string; assessmentData?: Record<string, unknown>; completedAt?: string } | null;
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
