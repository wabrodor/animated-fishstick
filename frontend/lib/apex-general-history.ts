export const APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION = 'apex-general-history-v1';

export const APEX_GENERAL_HISTORY_SECTIONS = [
  { id: 'PAST_MEDICAL', title: 'Past medical history', description: 'Previous diagnoses, procedures and hospital stays.' },
  { id: 'FAMILY', title: 'Family history', description: 'Relevant health conditions in close blood relatives.' },
  { id: 'SOCIAL', title: 'Social history', description: 'Patient reported habits, activity and daily routine.' },
  { id: 'ALLERGIES', title: 'Allergies', description: 'Medicine and other reported allergies.' },
  { id: 'REPRODUCTIVE', title: 'Reproductive health', description: 'Ask only when relevant and appropriate.' },
  { id: 'PRIOR_INVESTIGATIONS', title: 'Prior investigations', description: 'Recent tests or investigations relevant to care.' },
] as const;

const prompts = [
  ['past-hypertension', 'PAST_MEDICAL', 'Have you previously been diagnosed with high blood pressure?'],
  ['past-diabetes', 'PAST_MEDICAL', 'Have you previously been diagnosed with diabetes or high blood sugar?'],
  ['heart-disease', 'PAST_MEDICAL', 'Have you ever been diagnosed with heart disease or had a heart-related procedure?'],
  ['stroke-history', 'PAST_MEDICAL', 'Have you ever been diagnosed with a stroke or transient ischaemic attack (TIA)?'],
  ['kidney-disease', 'PAST_MEDICAL', 'Have you been told that you have kidney disease or reduced kidney function?'],
  ['thyroid-disease', 'PAST_MEDICAL', 'Have you been diagnosed with a thyroid condition?'],
  ['liver-disease', 'PAST_MEDICAL', 'Have you been diagnosed with a chronic liver condition?'],
  ['major-surgery-admission', 'PAST_MEDICAL', 'Have you had a major operation or hospital admission in the past?'],
  ['family-diabetes', 'FAMILY', 'Do any of your close blood relatives have diabetes?'],
  ['family-hypertension', 'FAMILY', 'Do any of your close blood relatives have high blood pressure?'],
  ['family-cardiovascular', 'FAMILY', 'Has a close blood relative had a heart attack or stroke, particularly at a younger age?'],
  ['family-kidney-disease', 'FAMILY', 'Does a close blood relative have kidney disease or kidney failure?'],
  ['tobacco-use', 'SOCIAL', 'Do you currently use or have you previously used tobacco in any form?'],
  ['alcohol-use', 'SOCIAL', 'Do you currently consume or have you previously consumed alcohol?'],
  ['regular-activity', 'SOCIAL', 'Do you currently take part in regular physical activity or exercise?'],
  ['medicine-allergy', 'ALLERGIES', 'Have you ever had an allergy or significant reaction to a medicine?'],
  ['other-allergy', 'ALLERGIES', 'Do you have any known food, latex or other non-medicine allergies?'],
  ['pregnancy-breastfeeding', 'REPRODUCTIVE', 'Are you currently pregnant, possibly pregnant or breastfeeding, where relevant?'],
  ['menstrual-history', 'REPRODUCTIVE', 'Have you experienced significant menstrual irregularity or a relevant reproductive-health concern, where applicable?'],
  ['prior-investigations', 'PRIOR_INVESTIGATIONS', 'Have you had any recent blood tests, scans or other investigations relevant to your current health conditions?'],
] as const;

export const APEX_GENERAL_HISTORY_QUESTIONS = prompts.map(([questionId, section, question]) => ({
  questionId,
  section,
  question,
  detailPrompt: 'Add the details shared by the patient, if known.',
  detailsRequiredOnYes: true,
}));
