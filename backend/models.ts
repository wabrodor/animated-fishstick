import mongoose, { InferSchemaType, Schema } from 'mongoose';

export const roles = [
  'PLATFORM_ADMIN',
  'APEXCARE_COORDINATOR',
  'APEXCARE_DIETITIAN',
  'APEXCARE_SPECIALIST',
  'APEXCARE_DOCTOR',
  'CLINIC_ADMIN',
  'CLINICIAN',
  'CLINIC_COORDINATOR',
  'PATIENT',
] as const;
export type Role = (typeof roles)[number];

const organizationSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  type: { type: String, enum: ['CLINIC', 'APEXCARE'], default: 'CLINIC', required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true },
  adminUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
}, { timestamps: true });
organizationSchema.index({ type: 1, status: 1 });

const userSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  roles: { type: [String], enum: roles, required: true },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true },
  mustChangePassword: { type: Boolean, default: false },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
}, { timestamps: true });
// Email is an account identifier. Keeping it globally unique avoids ambiguous login
// when the same email exists in multiple clinics.
userSchema.index({ email: 1 }, { unique: true });

const patientSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  medicalRecordNumber: { type: String, required: true, trim: true, maxlength: 64 },
  name: {
    first: { type: String, required: true, trim: true, maxlength: 80 },
    last: { type: String, trim: true, maxlength: 80 },
  },
  dateOfBirth: { type: Date },
  ageAtRegistration: { type: Number, min: 0, max: 130 },
  sexAtBirth: { type: String, enum: ['FEMALE', 'MALE', 'INTERSEX', 'NOT_RECORDED'] },
  phone: { type: String, trim: true, maxlength: 25 },
  whatsapp: { type: String, trim: true, maxlength: 25 },
  preferredLanguage: { type: String, default: 'en', trim: true, maxlength: 20 },
  preferredContactChannel: { type: String, enum: ['PHONE', 'SMS', 'WHATSAPP', 'APP'], default: 'PHONE' },
  assignedClinicianId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  enrolledByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  enrollmentStatus: { type: String, enum: ['NOT_ENROLLED', 'ENROLLED', 'CARE_PLAN_REVIEW', 'ACTIVE_CARE', 'INACTIVE'], default: 'NOT_ENROLLED', index: true },
  conditions: [{
    code: { type: String, enum: ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'], required: true },
    status: { type: String, enum: ['SUSPECTED', 'CONFIRMED', 'CONTROLLED', 'INACTIVE'], required: true },
    diagnosedAt: Date,
  }],
  programmeConsent: {
    acceptedAt: { type: Date },
    acceptedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    communicationConsent: { type: Boolean },
  },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
}, { timestamps: true });
patientSchema.index({ organizationId: 1, medicalRecordNumber: 1 }, { unique: true });
patientSchema.index({ organizationId: 1, phone: 1 });



const patientClinicRelationshipSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  relationshipType: { type: String, enum: ['PRIMARY', 'PREVIOUS', 'REFERRED'], required: true },
  status: { type: String, enum: ['ACTIVE', 'ENDED'], required: true, default: 'ACTIVE', index: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date },
  endedReason: { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });
patientClinicRelationshipSchema.index(
  { patientId: 1, clinicOrganizationId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);

const apexCareGeneralHistoryAnswerSchema = new Schema({
  questionId: { type: String, required: true, trim: true, maxlength: 80 },
  section: { type: String, enum: ['PAST_MEDICAL', 'FAMILY', 'SOCIAL', 'ALLERGIES', 'REPRODUCTIVE', 'PRIOR_INVESTIGATIONS'], required: true },
  question: { type: String, required: true, trim: true, maxlength: 300 },
  answer: { type: String, enum: ['YES', 'NO', 'UNKNOWN', 'DECLINED'], required: true },
  details: { type: String, trim: true, maxlength: 2000 },
}, { _id: false });

const apexCareGeneralHistoryEventSchema = new Schema({
  // New writes are coordinator collection events. Older review event values
  // remain accepted so legacy records can still be read and safely migrated.
  eventType: { type: String, enum: ['DRAFT_SAVED', 'RECORDED', 'SUBMITTED', 'RETURNED_FOR_CLARIFICATION', 'APPROVED'], required: true },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  actorRole: { type: String, enum: ['APEXCARE_COORDINATOR', 'APEXCARE_DOCTOR'], required: true },
  notes: { type: String, trim: true, maxlength: 3000 },
  createdAt: { type: Date, required: true, default: Date.now },
}, { _id: false });

const apexCareGeneralHistorySchema = new Schema({
  enrollmentId: { type: Schema.Types.ObjectId, ref: 'ApexCareEnrollment', required: true, unique: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  // New records move from IN_PROGRESS to RECORDED. Legacy review states
  // remain in the enum only so existing documents can be read during migration.
  status: { type: String, enum: ['NOT_STARTED', 'IN_PROGRESS', 'RECORDED', 'PENDING_REVIEW', 'COMPLETED', 'DECLINED'], required: true, default: 'IN_PROGRESS', index: true },
  questionnaireVersion: { type: String, required: true, trim: true, maxlength: 40 },
  answers: { type: [apexCareGeneralHistoryAnswerSchema], default: [] },
  notes: { type: String, trim: true, maxlength: 3000 },
  collectedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  lastUpdatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  collectedAt: { type: Date, required: true, default: Date.now },
  recordedAt: { type: Date },
  events: { type: [apexCareGeneralHistoryEventSchema], default: [] },
  // Legacy clinician-review fields are retained for historical document compatibility.
  // No active route or UI writes review decisions to these fields.
  submittedAt: { type: Date },
  reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  reviewNotes: { type: String, trim: true, maxlength: 3000 },
  reviewEvents: { type: [apexCareGeneralHistoryEventSchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });
apexCareGeneralHistorySchema.index({ apexcareOrganizationId: 1, status: 1, recordedAt: 1 });
apexCareGeneralHistorySchema.index({ clinicOrganizationId: 1, patientId: 1, createdAt: -1 });

const apexCareEnrollmentSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  status: { type: String, enum: ['PENDING', 'ACTIVE', 'PAUSED', 'ENDED'], required: true, default: 'PENDING', index: true },
  enrolledAt: { type: Date },
  endedAt: { type: Date },
  enrolledByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  coordinatorCallDueAt: { type: Date, index: true },
  coordinatorCallStatus: { type: String, enum: ['PENDING', 'CONTACTED', 'NO_ANSWER', 'ESCALATED'], default: 'PENDING', index: true },
  coordinatorCalledAt: { type: Date },
  generalHistoryId: { type: Schema.Types.ObjectId, ref: 'ApexCareGeneralHistory' },
  // Legacy review statuses remain accepted for existing enrollment documents;
  // new workflow writes use NOT_STARTED, IN_PROGRESS and RECORDED only.
  generalHistoryStatus: { type: String, enum: ['NOT_STARTED', 'IN_PROGRESS', 'RECORDED', 'PENDING_REVIEW', 'COMPLETED', 'DECLINED'], default: 'NOT_STARTED', index: true },
  generalHistoryUpdatedAt: { type: Date },
  generalHistoryRecordedAt: { type: Date },
  generalHistoryCompletedAt: { type: Date }, // legacy field; no longer written
  dietitianAssessmentStatus: { type: String, enum: ['PENDING', 'COMPLETED'], default: 'PENDING', index: true },
  carePlanDraftId: { type: Schema.Types.ObjectId, ref: 'CarePlanDraft' },
  carePlanGenerationStatus: { type: String, enum: ['NOT_STARTED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'NOT_STARTED', index: true },
  carePlanGenerationJobId: { type: String, trim: true, maxlength: 200 },
  carePlanGenerationAttempt: { type: Number, min: 0, default: 0 },
  carePlanGenerationError: { type: String, trim: true, maxlength: 1000 },
  carePlanGenerationAssessmentId: { type: Schema.Types.ObjectId, ref: 'DietitianAssessment', index: true },
}, { timestamps: true });
apexCareEnrollmentSchema.index({ apexcareOrganizationId: 1, status: 1, createdAt: -1 });
apexCareEnrollmentSchema.index(
  { patientId: 1, apexcareOrganizationId: 1 },
  { unique: true },
);

const apexCareReferralSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  referredByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  condition: { type: String, enum: ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'], required: true },
  status: { type: String, enum: ['PENDING_STAFF', 'ENROLLED', 'CANCELLED'], default: 'PENDING_STAFF', index: true },
  referredAt: { type: Date, required: true, default: Date.now, index: true },
  staffEscalationDueAt: { type: Date, required: true, index: true },
  staffEscalatedAt: { type: Date },
  enrolledAt: { type: Date },
  enrolledByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
apexCareReferralSchema.index({ clinicOrganizationId: 1, status: 1, referredAt: -1 });
apexCareReferralSchema.index({ apexcareOrganizationId: 1, status: 1, referredAt: -1 });
apexCareReferralSchema.index({ status: 1, staffEscalationDueAt: 1 });
apexCareReferralSchema.index(
  { patientId: 1, clinicOrganizationId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING_STAFF' } },
);

const medicalDocumentOcrLineSchema = new Schema({
  text: { type: String, trim: true, maxlength: 1000, required: true },
  confidence: { type: Number, min: 0, max: 1 },
  page: { type: Number, min: 1 },
  boundingBox: { type: [[Number]], default: undefined },
}, { _id: false });

const prescriptionDocumentSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  source: { type: String, enum: ['IMAGE', 'PAPER_IMAGE', 'EMR_DOCUMENT'], required: true },
  status: { type: String, enum: ['CAPTURED', 'ANALYZING', 'VERIFICATION_REQUIRED', 'VERIFIED', 'NEEDS_CLINICAL_REVIEW'], default: 'CAPTURED', index: true },
  fileName: { type: String, trim: true, maxlength: 255, required: true },
  mimeType: { type: String, trim: true, maxlength: 100, required: true },
  storageKey: { type: String, trim: true, maxlength: 500, required: true },
  storageProvider: { type: String, enum: ['local', 's3'] },
  originalFileName: { type: String, trim: true, maxlength: 255 },
  sizeBytes: { type: Number, min: 1 },
  sha256: { type: String, trim: true, match: /^[a-f0-9]{64}$/i },
  analysisStatus: { type: String, enum: ['NOT_STARTED', 'PENDING', 'COMPLETED', 'FAILED'], default: 'NOT_STARTED', index: true },
  ocrLines: { type: [medicalDocumentOcrLineSchema], default: [], validate: [(lines: unknown[]) => lines.length <= 1000, 'Too many OCR lines.'] },
  ocrFullText: { type: String, trim: true, maxlength: 20000 },
  ocrEngine: { type: String, enum: ['PADDLEOCR', 'LOCAL_PDF_TEXT'] },
  ocrEngineVersion: { type: String, trim: true, maxlength: 40 },
  ocrProcessedAt: { type: Date },
  ocrWarningCode: { type: String, trim: true, maxlength: 100 },
  processingVersion: { type: Number, min: 1, default: 1 },
  processingStage: { type: String, enum: ['QUEUED', 'OCR', 'AI_EXTRACTION', 'FINALIZE', 'COMPLETED', 'FAILED'], index: true },
  processingAttempts: { type: Number, min: 0, default: 0 },
  safeLastErrorCode: { type: String, trim: true, maxlength: 100 },
  structuringProvider: { type: String, enum: ['DEEPSEEK'] },
  structuringModel: { type: String, trim: true, maxlength: 120 },
  structuringPromptVersion: { type: String, trim: true, maxlength: 40 },
  structuringSchemaVersion: { type: String, trim: true, maxlength: 40 },
  clinicalReviewReason: { type: String, trim: true, maxlength: 1000 },
  capturedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  capturedAt: { type: Date, required: true, default: Date.now },
  verifiedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: { type: Date },
  staffSubmittedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  staffSubmittedAt: { type: Date },
}, { timestamps: true });
prescriptionDocumentSchema.index({ clinicOrganizationId: 1, patientId: 1, createdAt: -1 });
prescriptionDocumentSchema.index({ apexcareOrganizationId: 1, patientId: 1, createdAt: -1 });

const labDocumentSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  source: { type: String, enum: ['LAB_PDF'], required: true, default: 'LAB_PDF' },
  status: { type: String, enum: ['UPLOADED', 'PROCESSING', 'EXTRACTED', 'FAILED'], default: 'UPLOADED', index: true },
  fileName: { type: String, trim: true, maxlength: 255, required: true },
  mimeType: { type: String, enum: ['application/pdf'], required: true, default: 'application/pdf' },
  storageKey: { type: String, trim: true, maxlength: 500, required: true },
  sizeBytes: { type: Number, min: 1, required: true },
  sha256: { type: String, trim: true, match: /^[a-f0-9]{64}$/i, required: true },
  storageProvider: { type: String, enum: ['local', 's3'] },
  idempotencyKey: { type: String, trim: true, maxlength: 300, required: true },
  uploadedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, required: true, default: Date.now },
  extractionStatus: { type: String, enum: ['NOT_STARTED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'NOT_STARTED', index: true },
  extractionWarningCode: { type: String, trim: true, maxlength: 100 },
  ocrLines: { type: [medicalDocumentOcrLineSchema], default: [], validate: [(lines: unknown[]) => lines.length <= 1000, 'Too many OCR lines.'] },
  ocrEngine: { type: String, enum: ['PADDLEOCR', 'LOCAL_PDF_TEXT'] },
  ocrEngineVersion: { type: String, trim: true, maxlength: 40 },
  ocrProcessedAt: { type: Date },
  ocrWarningCode: { type: String, trim: true, maxlength: 100 },
  processingVersion: { type: Number, min: 1, default: 1 },
  processingStage: { type: String, enum: ['QUEUED', 'OCR', 'AI_EXTRACTION', 'FINALIZE', 'COMPLETED', 'FAILED'], index: true },
  processingAttempts: { type: Number, min: 0, default: 0 },
  safeLastErrorCode: { type: String, trim: true, maxlength: 100 },
  extractionError: { type: String, trim: true, maxlength: 1000 },
  extractionStartedAt: { type: Date },
  extractedText: { type: String, trim: true, maxlength: 100000 },
  extractionVersion: { type: Number, min: 1 },
  structuringStatus: { type: String, enum: ['NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'NOT_STARTED', index: true },
  structuringProvider: { type: String, enum: ['DEEPSEEK', 'DETERMINISTIC_RULES'] },
  structuringModel: { type: String, trim: true, maxlength: 120 },
  structuringPromptVersion: { type: String, trim: true, maxlength: 40 },
  structuringSchemaVersion: { type: String, trim: true, maxlength: 40 },
  structuringError: { type: String, trim: true, maxlength: 1000 },
  structuringStartedAt: { type: Date },
  structuringVersion: { type: Number, min: 1 },
  structuredAt: { type: Date },
  structuredResultCount: { type: Number, min: 0 },
  interpretationStatus: { type: String, enum: ['NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'NOT_STARTED', index: true },
  interpretationError: { type: String, trim: true, maxlength: 1000 },
  interpretationStartedAt: { type: Date },
  interpretationVersion: { type: Number, min: 1 },
  interpretedAt: { type: Date },
}, { timestamps: true });
labDocumentSchema.index({ clinicOrganizationId: 1, patientId: 1, sha256: 1 }, { unique: true });
labDocumentSchema.index({ clinicOrganizationId: 1, idempotencyKey: 1 }, { unique: true });
labDocumentSchema.index({ clinicOrganizationId: 1, patientId: 1, createdAt: -1 });
labDocumentSchema.index({ clinicOrganizationId: 1, 'processingStage': 1, uploadedAt: 1 });
labDocumentSchema.index({ apexcareOrganizationId: 1, patientId: 1, createdAt: -1 });

const labInterpretationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  labDocumentId: { type: Schema.Types.ObjectId, ref: 'LabDocument', required: true, index: true },
  interpretationKey: { type: String, required: true, trim: true, maxlength: 300 },
  interpretationVersion: { type: Number, required: true, min: 1 },
  provider: { type: String, required: true, trim: true, maxlength: 80 },
  model: { type: String, trim: true, maxlength: 120 },
  patientLanguage: { type: String, required: true, trim: true, maxlength: 20 },
  clinicianSummary: { type: String, required: true, trim: true, maxlength: 8000 },
  patientSummary: { type: String, required: true, trim: true, maxlength: 8000 },
  suggestedDiscussionPoints: { type: [String], default: [] },
  urgentReview: { type: Boolean, required: true, default: false },
  confidence: { type: Number, min: 0, max: 1, required: true },
  status: { type: String, enum: ['READY', 'FAILED'], required: true, default: 'READY', index: true },
  clinicianReviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'MODIFIED', 'REJECTED'], required: true, default: 'PENDING', index: true },
  clinicianReviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  clinicianReviewedAt: Date,
  clinicianApprovedSummary: { type: String, trim: true, maxlength: 8000 },
  patientApprovedSummary: { type: String, trim: true, maxlength: 8000 },
}, { timestamps: true });
labInterpretationSchema.index({ organizationId: 1, interpretationKey: 1 }, { unique: true });
labInterpretationSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
labInterpretationSchema.index({ apexcareOrganizationId: 1, clinicianReviewStatus: 1, createdAt: -1 });

const labResultSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  labDocumentId: { type: Schema.Types.ObjectId, ref: 'LabDocument', required: true, index: true },
  testName: { type: String, required: true, trim: true, maxlength: 160 },
  normalizedTestName: { type: String, required: true, trim: true, maxlength: 120, index: true },
  valueNumber: { type: Number },
  valueText: { type: String, required: true, trim: true, maxlength: 80 },
  unit: { type: String, trim: true, maxlength: 40 },
  referenceLow: { type: Number },
  referenceHigh: { type: Number },
  referenceRangeText: { type: String, trim: true, maxlength: 120 },
  abnormalFlag: { type: String, enum: ['HIGH', 'LOW', 'NORMAL', 'UNKNOWN'], required: true },
  specimen: { type: String, trim: true, maxlength: 120 },
  sourceText: { type: String, required: true, trim: true, maxlength: 1000 },
  sourcePage: { type: Number, min: 1 },
  extractionConfidence: { type: Number, min: 0, max: 1, required: true },
  extractionMethod: { type: String, enum: ['DEEPSEEK', 'DETERMINISTIC_RULES'] },
  extractionModel: { type: String, trim: true, maxlength: 120 },
  reviewStatus: { type: String, enum: ['UNVERIFIED', 'VERIFIED', 'SUPERSEDED'], default: 'UNVERIFIED', index: true },
  parserVersion: { type: Number, required: true, min: 1 },
  resultKey: { type: String, required: true, trim: true, maxlength: 300 },
}, { timestamps: true });
labResultSchema.index({ organizationId: 1, resultKey: 1 }, { unique: true });
labResultSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
labResultSchema.index({ labDocumentId: 1, normalizedTestName: 1 });

const medicationDraftItemSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  strength: { type: String, trim: true, maxlength: 80 },
  dose: { type: String, trim: true, maxlength: 80 },
  route: { type: String, trim: true, maxlength: 40 },
  frequency: { type: String, trim: true, maxlength: 80 },
  duration: { type: String, trim: true, maxlength: 80 },
  instructions: { type: String, trim: true, maxlength: 500 },
  confidence: { type: Number, min: 0, max: 1 },
  sourceText: { type: String, trim: true, maxlength: 1000 },
}, { _id: true });

const medicationDraftSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  prescriptionDocumentId: { type: Schema.Types.ObjectId, ref: 'PrescriptionDocument', required: true, index: true },
  extractionSource: { type: String, enum: ['OCR', 'MANUAL_TRANSCRIPTION'], required: true },
  status: { type: String, enum: ['DRAFT', 'VERIFICATION_REQUIRED', 'VERIFYING', 'VERIFIED', 'REJECTED'], default: 'DRAFT', index: true },
  rawText: { type: String, trim: true, maxlength: 20000 },
  medications: { type: [medicationDraftItemSchema], default: [] },
  extractedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  verifiedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  rejectionReason: { type: String, trim: true, maxlength: 1000 },
  clinicalReviewRequired: { type: Boolean, default: false, index: true },
  clinicalReviewReason: { type: String, trim: true, maxlength: 1000 },
  analysisVersion: { type: Number, default: 1 },
  staffSubmittedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  staffSubmittedAt: { type: Date },
}, { timestamps: true });
medicationDraftSchema.index({ clinicOrganizationId: 1, patientId: 1, createdAt: -1 });
medicationDraftSchema.index({ apexcareOrganizationId: 1, patientId: 1, status: 1, createdAt: -1 });
medicationDraftSchema.index({ prescriptionDocumentId: 1, createdAt: -1 });
medicationDraftSchema.index({ clinicOrganizationId: 1, clinicalReviewRequired: 1, status: 1, createdAt: -1 });

const medicationRecordSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  prescriptionDocumentId: { type: Schema.Types.ObjectId, ref: 'PrescriptionDocument', required: true, index: true },
  medicationDraftId: { type: Schema.Types.ObjectId, ref: 'MedicationDraft', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  strength: { type: String, trim: true, maxlength: 80 },
  dose: { type: String, trim: true, maxlength: 80 },
  route: { type: String, trim: true, maxlength: 40 },
  frequency: { type: String, trim: true, maxlength: 80 },
  duration: { type: String, trim: true, maxlength: 80 },
  instructions: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ['ACTIVE', 'DISCONTINUED'], default: 'ACTIVE', index: true },
  startedAt: { type: Date, required: true, default: Date.now },
  discontinuedAt: { type: Date },
  discontinuedReason: { type: String, trim: true, maxlength: 1000 },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  medicationKey: { type: String, required: true, trim: true, maxlength: 300 },
}, { timestamps: true });
medicationRecordSchema.index({ clinicOrganizationId: 1, patientId: 1, status: 1, createdAt: -1 });
medicationRecordSchema.index({ apexcareOrganizationId: 1, patientId: 1, status: 1, createdAt: -1 });
medicationRecordSchema.index({ patientId: 1, medicationKey: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });

const medicationHistorySchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  medicationRecordId: { type: Schema.Types.ObjectId, ref: 'MedicationRecord', required: true, index: true },
  prescriptionDocumentId: { type: Schema.Types.ObjectId, ref: 'PrescriptionDocument', required: true, index: true },
  medicationDraftId: { type: Schema.Types.ObjectId, ref: 'MedicationDraft', required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  action: { type: String, enum: ['CREATED', 'UPDATED', 'DISCONTINUED'], required: true },
  snapshot: {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    strength: { type: String, trim: true, maxlength: 80 },
    dose: { type: String, trim: true, maxlength: 80 },
    route: { type: String, trim: true, maxlength: 40 },
    frequency: { type: String, trim: true, maxlength: 80 },
    duration: { type: String, trim: true, maxlength: 80 },
    instructions: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ['ACTIVE', 'DISCONTINUED'], required: true },
  },
  reason: { type: String, trim: true, maxlength: 1000 },
  changedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  changedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true });
medicationHistorySchema.index({ clinicOrganizationId: 1, patientId: 1, changedAt: -1 });
medicationHistorySchema.index({ apexcareOrganizationId: 1, patientId: 1, changedAt: -1 });
medicationHistorySchema.index({ medicationRecordId: 1, version: 1 }, { unique: true });

const dietitianAssessmentSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  dietitianUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  apexCareEnrollmentId: { type: Schema.Types.ObjectId, ref: 'ApexCareEnrollment' },
  remarks: { type: String, required: true, trim: true, maxlength: 5000 },
  assessmentData: { type: Schema.Types.Mixed },
  completedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true });
dietitianAssessmentSchema.index({ apexcareOrganizationId: 1, patientId: 1, completedAt: -1 });
dietitianAssessmentSchema.index({ apexCareEnrollmentId: 1 }, { unique: true, sparse: true });

const diagnosisSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  condition: { type: String, enum: ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'], required: true },
  status: { type: String, enum: ['CONFIRMED', 'INACTIVE'], default: 'CONFIRMED', index: true },
  diagnosedAt: { type: Date, required: true },
  diagnosedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  source: { type: String, enum: ['CLINICIAN'], default: 'CLINICIAN' },
  notes: { type: String, trim: true, maxlength: 2000 },
}, { timestamps: true });
diagnosisSchema.index({ organizationId: 1, patientId: 1, condition: 1, status: 1 });

const programConsentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  program: { type: String, enum: ['APEXCARE_CHRONIC_CARE'], required: true },
  consentGiven: { type: Boolean, required: true },
  consentAt: { type: Date, required: true },
  method: { type: String, enum: ['VERBAL', 'WRITTEN', 'DIGITAL'], required: true },
  recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  consentVersion: { type: String, required: true, trim: true, maxlength: 40 },
  communicationConsent: { type: Boolean, required: true },
  withdrawnAt: Date,
}, { timestamps: true });
programConsentSchema.index({ organizationId: 1, patientId: 1, program: 1, consentAt: -1 });

const goalSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  target: { type: String, trim: true, maxlength: 120 },
  unit: { type: String, trim: true, maxlength: 32 },
}, { _id: false });

const carePlanSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  condition: { type: String, enum: ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'], required: true },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'], default: 'DRAFT', index: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  goals: { type: [goalSchema], default: [] },
  version: { type: Number, default: 1, min: 1 },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  approvedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  lastAdjustedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  lastAdjustedAt: Date,
}, { timestamps: true });
carePlanSchema.index({ organizationId: 1, patientId: 1, status: 1 });
carePlanSchema.index(
  { organizationId: 1, patientId: 1, condition: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);

const carePlanDraftGoalSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  target: { type: String, trim: true, maxlength: 120 },
  unit: { type: String, trim: true, maxlength: 32 },
  rationale: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const carePlanDraftTaskSchema = new Schema({
  type: { type: String, enum: ['OPD_VISIT', 'VITALS', 'LAB', 'MEDICATION', 'DIETITIAN_SESSION', 'FOLLOW_UP'], required: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  dueDay: { type: Number, required: true, min: 0, max: 90 },
  rationale: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const carePlanDraftSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  condition: { type: String, enum: ['HYPERTENSION'], required: true },
  status: { type: String, enum: ['CLINICIAN_REVIEW', 'GENERATED', 'APPROVED', 'REJECTED', 'EXPIRED'], default: 'CLINICIAN_REVIEW', index: true },
  generatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  approvedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  clinicianNotifiedAt: Date,
  clinicianReviewDueAt: { type: Date, index: true },
  fallbackEligibleAt: { type: Date, index: true },
  fallbackApprovedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  fallbackApprovedAt: Date,
  rejectedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  source: { type: String, enum: ['AI', 'RULES'], required: true },
  provider: { type: String, trim: true, maxlength: 80 },
  model: { type: String, trim: true, maxlength: 120 },
  inputSnapshot: { type: Schema.Types.Mixed, required: true },
  plan: {
    summary: { type: String, required: true, trim: true, maxlength: 2000 },
    goals: { type: [carePlanDraftGoalSchema], default: [] },
    tasks: { type: [carePlanDraftTaskSchema], default: [] },
    clinicalInterventionNeeded: { type: Boolean, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    safetyNotes: { type: [String], default: [] },
  },
}, { timestamps: true });
carePlanDraftSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
carePlanDraftSchema.index({ organizationId: 1, patientId: 1, condition: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'CLINICIAN_REVIEW' } });

const careProtocolMilestoneDefinitionSchema = new Schema({
  key: { type: String, required: true, trim: true, maxlength: 80 },
  label: { type: String, required: true, trim: true, maxlength: 180 },
  offsetDays: { type: Number, min: 0, max: 3650, default: 0 },
  sequence: { type: Number, required: true, min: 1, default: 1 },
  reviewRequired: { type: Boolean, default: false },
}, { _id: false });

const careProtocolSchema = new Schema({
  protocolKey: { type: String, required: true, trim: true, maxlength: 80 },
  version: { type: String, required: true, trim: true, maxlength: 40 },
  condition: { type: String, enum: ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'], required: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  jurisdiction: { type: String, trim: true, maxlength: 80, default: 'IN' },
  durationDays: { type: Number, required: true, min: 0, max: 3650 },
  milestones: { type: [careProtocolMilestoneDefinitionSchema], default: [] },
}, { timestamps: true });
careProtocolSchema.index({ protocolKey: 1, version: 1 }, { unique: true });
careProtocolSchema.index(
  { condition: 1, jurisdiction: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);

const careTaskSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan', required: true, index: true },
  executionId: { type: Schema.Types.ObjectId, ref: 'CarePlanExecution', index: true },
  milestoneId: { type: Schema.Types.ObjectId, ref: 'CarePlanMilestone', index: true },
  taskKey: { type: String, trim: true, maxlength: 220 },
  type: { type: String, enum: ['OPD_VISIT', 'VITALS', 'LAB', 'MEDICATION', 'DIETITIAN_SESSION', 'FOLLOW_UP'], required: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  dueAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['PENDING', 'COMPLETED', 'SKIPPED', 'OVERDUE'], default: 'PENDING', index: true },
  completedAt: Date,
  completedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  contactStatus: { type: String, enum: ['NOT_CONTACTED', 'CONTACTED', 'UNANSWERED', 'MESSAGE_QUEUED'], default: 'NOT_CONTACTED', index: true },
  lastContactedAt: Date,
  lastContactedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  contactNotes: { type: String, trim: true, maxlength: 1000 },
}, { timestamps: true });
careTaskSchema.index({ organizationId: 1, status: 1, dueAt: 1 });
careTaskSchema.index({ organizationId: 1, patientId: 1, executionId: 1, status: 1, dueAt: 1 });
careTaskSchema.index({ executionId: 1, taskKey: 1 }, { unique: true, partialFilterExpression: { executionId: { $exists: true }, taskKey: { $exists: true } } });


const carePlanExecutionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan', required: true, index: true },
  condition: { type: String, enum: ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'], required: true },
  protocolKey: { type: String, trim: true, maxlength: 80, index: true },
  protocolVersion: { type: String, trim: true, maxlength: 40 },
  status: { type: String, enum: ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'], default: 'ACTIVE', index: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  activationKey: { type: String, required: true, trim: true, maxlength: 200 },
}, { timestamps: true });
carePlanExecutionSchema.index({ organizationId: 1, patientId: 1, carePlanId: 1 }, { unique: true });
carePlanExecutionSchema.index({ organizationId: 1, patientId: 1, status: 1, startDate: -1 });
carePlanExecutionSchema.index({ activationKey: 1 }, { unique: true });

const carePlanMilestoneSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan', required: true, index: true },
  executionId: { type: Schema.Types.ObjectId, ref: 'CarePlanExecution', required: true, index: true },
  key: { type: String, required: true, trim: true, maxlength: 80 },
  offsetDays: { type: Number, min: 0, max: 3650, default: 0 },
  day: { type: Number, required: true, min: 0, max: 3650 },
  dueAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['PLANNED', 'DUE', 'COMPLETED', 'COMPLETED_EARLY', 'SKIPPED', 'CANCELLED'], default: 'PLANNED', index: true },
  reviewRequired: { type: Boolean, default: false, index: true },
  completedAt: Date,
  completedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
carePlanMilestoneSchema.index({ executionId: 1, key: 1 }, { unique: true });
carePlanMilestoneSchema.index({ organizationId: 1, patientId: 1, status: 1, dueAt: 1 });
carePlanMilestoneSchema.index({ organizationId: 1, executionId: 1, status: 1, dueAt: 1 });


const outboxEventSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  eventKey: { type: String, required: true, trim: true, maxlength: 300 },
  eventType: { type: String, required: true, trim: true, maxlength: 120, index: true },
  aggregateType: { type: String, required: true, trim: true, maxlength: 80 },
  aggregateId: { type: Schema.Types.ObjectId, required: true, index: true },
  payload: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'], default: 'PENDING', index: true },
  attempts: { type: Number, required: true, min: 0, default: 0 },
  availableAt: { type: Date, required: true, default: Date.now, index: true },
  processingStartedAt: { type: Date, index: true },
  publishedAt: Date,
  lastError: { type: String, trim: true, maxlength: 1000 },
}, { timestamps: true });
outboxEventSchema.index({ organizationId: 1, eventKey: 1 }, { unique: true });
outboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
outboxEventSchema.index({ organizationId: 1, status: 1, createdAt: -1 });


const patientCommunicationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan', required: true, index: true },
  taskId: { type: Schema.Types.ObjectId, ref: 'CareTask', index: true },
  purpose: { type: String, enum: ['CARE_PLAN_ACTIVATION', 'CARE_TASK_REMINDER', 'PATIENT_REVIEW_REMINDER'], required: true, default: 'CARE_PLAN_ACTIVATION', index: true },
  channel: { type: String, enum: ['WHATSAPP', 'APP'], required: true },
  language: { type: String, required: true, trim: true, maxlength: 20 },
  message: { type: String, required: true, trim: true, maxlength: 4000 },
  status: { type: String, enum: ['PENDING', 'READY', 'SENT', 'FAILED'], default: 'PENDING', index: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 300 },
  sentAt: Date,
  failureReason: { type: String, trim: true, maxlength: 1000 },
}, { timestamps: true });
patientCommunicationSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
patientCommunicationSchema.index({ organizationId: 1, patientId: 1, createdAt: -1 });
patientCommunicationSchema.index({ organizationId: 1, taskId: 1, purpose: 1 }, { unique: true, partialFilterExpression: { taskId: { $exists: true }, purpose: 'CARE_TASK_REMINDER' } });

const subscriptionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
  planCode: { type: String, required: true, trim: true },
  status: { type: String, enum: ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'], required: true },
  activePatientLimit: { type: Number, required: true, min: 1 },
  activePatientCount: { type: Number, required: true, min: 0, default: 0 },
  currentPeriodStart: { type: Date, required: true },
  currentPeriodEnd: { type: Date, required: true },
  billingInterval: { type: String, enum: ['MONTHLY'], default: 'MONTHLY' },
}, { timestamps: true });



const patientReviewQuestionSchema = new Schema(
  {
    questionId: { type: String, required: true, trim: true, maxlength: 80 },
    topic: {
      type: String,
      enum: ['MEDICATION_ADHERENCE', 'DIET_ADHERENCE', 'LIFESTYLE_ADHERENCE', 'LABS', 'SYMPTOMS', 'CARE_PLAN', 'PATIENT_CONCERNS'],
      required: true,
    },
    question: { type: String, required: true, trim: true, maxlength: 300 },
    answer: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const patientReviewAdherenceSnapshotSchema = new Schema(
  {
    periodStartAt: { type: Date, required: true },
    periodEndAt: { type: Date, required: true },
    totalDueTasks: { type: Number, required: true, min: 0 },
    completedTasks: { type: Number, required: true, min: 0 },
    skippedTasks: { type: Number, required: true, min: 0 },
    overdueTasks: { type: Number, required: true, min: 0 },
    pendingTasks: { type: Number, required: true, min: 0 },
    completionRate: { type: Number, required: true, min: 0, max: 1 },
    actionedRate: { type: Number, required: true, min: 0, max: 1 },
    byType: { type: Schema.Types.Mixed, required: true, default: {} },
    generatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const patientReviewSummarySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    reviewId: { type: Schema.Types.ObjectId, ref: 'PatientReview', required: true, index: true },
    executionId: { type: Schema.Types.ObjectId, ref: 'CarePlanExecution', required: true, index: true },
    milestoneId: { type: Schema.Types.ObjectId, ref: 'CarePlanMilestone', required: true, index: true },
    summaryKey: { type: String, required: true, trim: true, maxlength: 220 },
    version: { type: Number, required: true, min: 1, default: 1 },
    language: { type: String, required: true, trim: true, maxlength: 20, default: 'en' },
    status: { type: String, enum: ['GENERATING', 'COMPLETED', 'FAILED'], required: true, default: 'GENERATING', index: true },
    clinicianSummary: { type: String, trim: true, maxlength: 12000 },
    patientSummary: { type: String, trim: true, maxlength: 12000 },
    suggestedActions: { type: [String], default: [] },
    clinicianReviewRequired: { type: Boolean, default: true },
    provider: { type: String, trim: true, maxlength: 80 },
    model: { type: String, trim: true, maxlength: 160 },
    generatedAt: Date,
    generationStartedAt: Date,
    attempts: { type: Number, min: 0, default: 0 },
    lastError: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);
patientReviewSummarySchema.index({ organizationId: 1, summaryKey: 1 }, { unique: true });
patientReviewSummarySchema.index({ organizationId: 1, patientId: 1, reviewId: 1, version: 1 }, { unique: true });

const patientReviewSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan', required: true, index: true },
    executionId: { type: Schema.Types.ObjectId, ref: 'CarePlanExecution', required: true, index: true },
    milestoneId: { type: Schema.Types.ObjectId, ref: 'CarePlanMilestone', required: true, index: true },
    reviewKey: { type: String, required: true, trim: true, maxlength: 220 },
    status: { type: String, enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED'], default: 'OPEN', index: true },
    dueAt: { type: Date, required: true, index: true },
    startedAt: Date,
    completedAt: Date,
    completedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    contactStatus: { type: String, enum: ['NOT_CONTACTED', 'CONTACTED', 'UNANSWERED', 'MESSAGE_QUEUED'], default: 'NOT_CONTACTED', index: true },
    lastContactedAt: Date,
    lastContactedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    contactNotes: { type: String, trim: true, maxlength: 1000 },
    questions: { type: [patientReviewQuestionSchema], default: [] },
    vitalsRecordId: { type: Schema.Types.ObjectId, ref: 'VitalRecord' },
    notes: { type: String, trim: true, maxlength: 3000 },
    adherenceSnapshot: { type: patientReviewAdherenceSnapshotSchema },
  },
  { timestamps: true },
);
patientReviewSchema.index({ organizationId: 1, reviewKey: 1 }, { unique: true });
patientReviewSchema.index({ organizationId: 1, patientId: 1, dueAt: 1, status: 1 });
patientReviewSchema.index({ executionId: 1, milestoneId: 1 }, { unique: true });


const clinicalSignalSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  sourceType: { type: String, enum: ['LAB_INTERPRETATION', 'ADHERENCE_REVIEW'], required: true, index: true },
  sourceId: { type: Schema.Types.ObjectId, required: true, index: true },
  signalKey: { type: String, required: true, trim: true, maxlength: 300 },
  kind: { type: String, enum: ['URGENT_LAB', 'ABNORMAL_LAB', 'LOW_ADHERENCE', 'REPEATED_MISSED_TASKS'], required: true, index: true },
  priority: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], required: true, default: 'MEDIUM', index: true },
  status: { type: String, enum: ['OPEN', 'REVIEWED', 'ACTION_REQUIRED', 'DISMISSED'], required: true, default: 'OPEN', index: true },
  summary: { type: String, required: true, trim: true, maxlength: 4000 },
  evidence: { type: Schema.Types.Mixed, required: true, default: {} },
  reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNotes: { type: String, trim: true, maxlength: 2000 },
  actionTaskId: { type: Schema.Types.ObjectId, ref: 'CareTask', index: true },
}, { timestamps: true });
clinicalSignalSchema.index({ organizationId: 1, signalKey: 1 }, { unique: true });
clinicalSignalSchema.index({ organizationId: 1, status: 1, priority: -1, createdAt: 1 });
clinicalSignalSchema.index({ organizationId: 1, patientId: 1, status: 1, createdAt: -1 });

const coordinatorEscalationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  executionId: { type: Schema.Types.ObjectId, ref: 'CarePlanExecution', required: true, index: true },
  reviewId: { type: Schema.Types.ObjectId, ref: 'PatientReview', required: true, index: true },
  milestoneId: { type: Schema.Types.ObjectId, ref: 'CarePlanMilestone', required: true, index: true },
  escalationKey: { type: String, required: true, trim: true, maxlength: 300 },
  reason: { type: String, enum: ['LOW_ADHERENCE', 'REPEATED_MISSED_TASKS'], required: true, index: true },
  priority: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], required: true, default: 'MEDIUM', index: true },
  status: { type: String, enum: ['OPEN', 'RESOLVED'], required: true, default: 'OPEN', index: true },
  evidence: { type: Schema.Types.Mixed, required: true, default: {} },
  openedAt: { type: Date, required: true, index: true },
  resolvedAt: Date,
  resolvedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  outcome: { type: String, trim: true, maxlength: 500 },
  resolutionNotes: { type: String, trim: true, maxlength: 2000 },
}, { timestamps: true });
coordinatorEscalationSchema.index({ organizationId: 1, escalationKey: 1 }, { unique: true });
coordinatorEscalationSchema.index({ organizationId: 1, status: 1, priority: -1, openedAt: 1 });
coordinatorEscalationSchema.index({ organizationId: 1, patientId: 1, status: 1 });

const visitReviewAnswerSchema = new Schema(
  {
    questionId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    topic: {
      type: String,
      enum: [
        'MEDICATION_ADHERENCE',
        'HOME_BP',
        'SYMPTOMS',
        'LABS',
        'LIFESTYLE',
        'CARE_PLAN',
        'FOLLOW_UP',
      ],
      required: true,
    },

    question: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },

    answer: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { _id: false },
);

const visitReviewSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },

    coordinatorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    visitAt: {
      type: Date,
      required: true,
      index: true,
    },

    assistantRunAt: {
      type: Date,
      required: true,
    },

    answers: {
      type: [visitReviewAnswerSchema],
      default: [],
    },

    completedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

visitReviewSchema.index({
  organizationId: 1,
  patientId: 1,
  visitAt: -1,
});


const clinicalReviewCaseSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  prescriptionDocumentId: { type: Schema.Types.ObjectId, ref: 'PrescriptionDocument', required: true, index: true },
  medicationDraftId: { type: Schema.Types.ObjectId, ref: 'MedicationDraft', required: true, unique: true },
  clinicClinicianId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  apexcareAssignedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  reasonCode: {
    type: String,
    enum: ['AI_VERIFICATION_REQUIRED', 'AI_DISCREPANCY', 'AI_ANALYSIS_FAILURE', 'AI_VERIFICATION_FAILURE', 'STAFF_REJECTED'],
    required: true,
    index: true,
  },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  status: {
    type: String,
    enum: ['CLINICIAN_REVIEW', 'APEXCARE_REVIEW', 'APPROVED', 'REJECTED'],
    default: 'CLINICIAN_REVIEW',
    index: true,
  },
  decision: { type: String, enum: ['APPROVED', 'REJECTED', 'ESCALATED'] },
  decisionReason: { type: String, trim: true, maxlength: 1000 },
  clinicReviewDueAt: { type: Date, required: true, index: true },
  clinicReviewedAt: Date,
  apexcareEscalatedAt: Date,
  apexcareReviewedAt: Date,
  reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
}, { timestamps: true });
clinicalReviewCaseSchema.index({ clinicOrganizationId: 1, clinicClinicianId: 1, status: 1, clinicReviewDueAt: 1 });
clinicalReviewCaseSchema.index({ apexcareOrganizationId: 1, status: 1, createdAt: -1 });
clinicalReviewCaseSchema.index({ apexcareOrganizationId: 1, apexcareAssignedUserId: 1, status: 1 });

const clinicalReviewEventSchema = new Schema({
  clinicalReviewCaseId: { type: Schema.Types.ObjectId, ref: 'ClinicalReviewCase', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  eventType: { type: String, enum: ['OPENED', 'ESCALATED', 'CLAIMED', 'DECISION'], required: true },
  fromStatus: { type: String, enum: ['CLINICIAN_REVIEW', 'APEXCARE_REVIEW', 'APPROVED', 'REJECTED'] },
  toStatus: { type: String, enum: ['CLINICIAN_REVIEW', 'APEXCARE_REVIEW', 'APPROVED', 'REJECTED'] },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorType: { type: String, enum: ['SYSTEM', 'CLINICIAN', 'APEXCARE_DOCTOR'], required: true },
  decision: { type: String, enum: ['APPROVED', 'REJECTED', 'ESCALATED'] },
  reason: { type: String, trim: true, maxlength: 1000 },
}, { timestamps: true });
clinicalReviewEventSchema.index({ clinicalReviewCaseId: 1, createdAt: 1 });

const serviceCaseSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  clinicOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  apexcareOrganizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  requestedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  service: { type: String, enum: ['DIETITIAN', 'ENDOCRINOLOGY'], required: true },
  status: { type: String, enum: ['REQUESTED', 'ASSIGNED', 'SCHEDULED', 'COMPLETED', 'CANCELLED'], default: 'REQUESTED', index: true },
  assignedApexcareUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  reason: { type: String, trim: true, maxlength: 1000, required: true },
  handoffSummary: { type: String, trim: true, maxlength: 5000 },
}, { timestamps: true });
serviceCaseSchema.index({ organizationId: 1, status: 1, createdAt: 1 });
serviceCaseSchema.index({ apexcareOrganizationId: 1, status: 1, createdAt: -1 });
serviceCaseSchema.index({ apexcareOrganizationId: 1, assignedApexcareUserId: 1, status: 1 });

const bloodPressureSchema = new Schema({
  systolic: { type: Number, required: true, min: 40, max: 300 },
  diastolic: { type: Number, required: true, min: 20, max: 200 },
  pulse: { type: Number, min: 20, max: 250 },
}, { _id: false });

const bloodSugarSchema = new Schema({
  value: { type: Number, required: true, min: 10, max: 1000 },
  type: { type: String, enum: ['FASTING', 'POST_PRANDIAL', 'RANDOM', 'HBA1C'], required: true },
  unit: { type: String, enum: ['MG_DL', 'PERCENT'], required: true },
}, { _id: false });

const vitalRecordSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  recordedAt: { type: Date, required: true, index: true },
  recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  source: { type: String, enum: ['OPD', 'HOME', 'DEVICE'], required: true },
  bloodPressure: bloodPressureSchema,
  bloodSugar: bloodSugarSchema,
  weightKg: { type: Number, min: 1, max: 500 },
  symptoms: { type: [String], default: [] },
  notes: { type: String, trim: true, maxlength: 2000 },
}, { timestamps: true });
vitalRecordSchema.index({ organizationId: 1, patientId: 1, recordedAt: -1 });

const opdVisitSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  visitAt: { type: Date, required: true, index: true },
  recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  clinicianId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reason: { type: String, trim: true, maxlength: 500 },
  assessment: { type: String, trim: true, maxlength: 5000 },
  planAdjustment: { type: String, trim: true, maxlength: 5000 },
  carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan' },
  vitalsRecordId: { type: Schema.Types.ObjectId, ref: 'VitalRecord' },
}, { timestamps: true });
opdVisitSchema.index({ organizationId: 1, patientId: 1, visitAt: -1 });

export type UserDocument = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId };
export const Organization = mongoose.model('Organization', organizationSchema);
export const User = mongoose.model('User', userSchema);
export const Patient = mongoose.model('Patient', patientSchema);
export const PatientClinicRelationship = mongoose.model('PatientClinicRelationship', patientClinicRelationshipSchema);
export const ApexCareGeneralHistory = mongoose.model('ApexCareGeneralHistory', apexCareGeneralHistorySchema);
export const ApexCareEnrollment = mongoose.model('ApexCareEnrollment', apexCareEnrollmentSchema);
export const ApexCareReferral = mongoose.model('ApexCareReferral', apexCareReferralSchema);
export const PrescriptionDocument = mongoose.model('PrescriptionDocument', prescriptionDocumentSchema);
export const LabDocument = mongoose.model('LabDocument', labDocumentSchema);
export const LabResult = mongoose.model('LabResult', labResultSchema);
export const LabInterpretation = mongoose.model('LabInterpretation', labInterpretationSchema);
export const MedicationDraft = mongoose.model('MedicationDraft', medicationDraftSchema);
export const MedicationRecord = mongoose.model('MedicationRecord', medicationRecordSchema);
export const MedicationHistory = mongoose.model('MedicationHistory', medicationHistorySchema);
export const DietitianAssessment = mongoose.model('DietitianAssessment', dietitianAssessmentSchema);
export const Diagnosis = mongoose.model('Diagnosis', diagnosisSchema);
export const ProgramConsent = mongoose.model('ProgramConsent', programConsentSchema);
export const CarePlan = mongoose.model('CarePlan', carePlanSchema);
export const CarePlanDraft = mongoose.model('CarePlanDraft', carePlanDraftSchema);
export const CareProtocol = mongoose.model('CareProtocol', careProtocolSchema);
export const CareTask = mongoose.model('CareTask', careTaskSchema);
export const CarePlanExecution = mongoose.model('CarePlanExecution', carePlanExecutionSchema);
export const CarePlanMilestone = mongoose.model('CarePlanMilestone', carePlanMilestoneSchema);
export const PatientReview = mongoose.model('PatientReview', patientReviewSchema);
export const PatientReviewSummary = mongoose.model('PatientReviewSummary', patientReviewSummarySchema);
export const CoordinatorEscalation = mongoose.model('CoordinatorEscalation', coordinatorEscalationSchema);
export const ClinicalSignal = mongoose.model('ClinicalSignal', clinicalSignalSchema);
export const VisitReview = mongoose.model(
  'VisitReview',
  visitReviewSchema,
);
export const Subscription = mongoose.model('Subscription', subscriptionSchema);

const notificationSchema = new Schema({
  notificationKey: { type: String, required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventType: { type: String, required: true, trim: true, maxlength: 120, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  body: { type: String, required: true, trim: true, maxlength: 500 },
  href: { type: String, trim: true, maxlength: 300 },
  priority: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM', index: true },
  aggregateType: { type: String, required: true, trim: true, maxlength: 80 },
  aggregateId: { type: Schema.Types.ObjectId, required: true, index: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  readAt: { type: Date, index: true },
}, { timestamps: true });
notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ organizationId: 1, recipientUserId: 1, createdAt: -1 });

export const OutboxEvent = mongoose.model('OutboxEvent', outboxEventSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const PatientCommunication = mongoose.model('PatientCommunication', patientCommunicationSchema);
export const ClinicalReviewCase = mongoose.model('ClinicalReviewCase', clinicalReviewCaseSchema);
export const ClinicalReviewEvent = mongoose.model('ClinicalReviewEvent', clinicalReviewEventSchema);
export const ServiceCase = mongoose.model('ServiceCase', serviceCaseSchema);
export const VitalRecord = mongoose.model('VitalRecord', vitalRecordSchema);
export const OpdVisit = mongoose.model('OpdVisit', opdVisitSchema);
