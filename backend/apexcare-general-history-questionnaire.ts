/**
 * Canonical, versioned ApexCare general medical-history questionnaire.
 * Keep the question IDs, sections and prompts aligned with frontend/lib/apex-general-history.ts.
 * Medication history is intentionally excluded and remains in its separate workflow.
 */
export const APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION = 'apex-general-history-v1';

export const APEX_GENERAL_HISTORY_QUESTIONS = [
  { questionId: 'past-hypertension', section: 'PAST_MEDICAL', question: 'Have you previously been diagnosed with high blood pressure?', detailPrompt: 'Approximate year of diagnosis and any important details.', detailsRequiredOnYes: true },
  { questionId: 'past-diabetes', section: 'PAST_MEDICAL', question: 'Have you previously been diagnosed with diabetes or high blood sugar?', detailPrompt: 'Approximate year of diagnosis and any important details.', detailsRequiredOnYes: true },
  { questionId: 'heart-disease', section: 'PAST_MEDICAL', question: 'Have you ever been diagnosed with heart disease or had a heart-related procedure?', detailPrompt: 'Describe the diagnosis or procedure and approximate date.', detailsRequiredOnYes: true },
  { questionId: 'stroke-history', section: 'PAST_MEDICAL', question: 'Have you ever been diagnosed with a stroke or transient ischaemic attack (TIA)?', detailPrompt: 'Describe when it occurred and any lasting effects, if known.', detailsRequiredOnYes: true },
  { questionId: 'kidney-disease', section: 'PAST_MEDICAL', question: 'Have you been told that you have kidney disease or reduced kidney function?', detailPrompt: 'Add the diagnosis or approximate date, if known.', detailsRequiredOnYes: true },
  { questionId: 'thyroid-disease', section: 'PAST_MEDICAL', question: 'Have you been diagnosed with a thyroid condition?', detailPrompt: 'Specify the condition and approximate date, if known.', detailsRequiredOnYes: true },
  { questionId: 'liver-disease', section: 'PAST_MEDICAL', question: 'Have you been diagnosed with a chronic liver condition?', detailPrompt: 'Specify the condition and approximate date, if known.', detailsRequiredOnYes: true },
  { questionId: 'major-surgery-admission', section: 'PAST_MEDICAL', question: 'Have you had a major operation or hospital admission in the past?', detailPrompt: 'Mention the reason, procedure and approximate date.', detailsRequiredOnYes: true },
  { questionId: 'family-diabetes', section: 'FAMILY', question: 'Do any of your close blood relatives (parents, siblings or children) have diabetes?', detailPrompt: 'Identify the relative(s), if known.', detailsRequiredOnYes: true },
  { questionId: 'family-hypertension', section: 'FAMILY', question: 'Do any of your close blood relatives have high blood pressure?', detailPrompt: 'Identify the relative(s), if known.', detailsRequiredOnYes: true },
  { questionId: 'family-cardiovascular', section: 'FAMILY', question: 'Has a close blood relative had a heart attack or stroke, particularly at a younger age?', detailPrompt: 'Identify the relative and their approximate age at the event, if known.', detailsRequiredOnYes: true },
  { questionId: 'family-kidney-disease', section: 'FAMILY', question: 'Does a close blood relative have kidney disease or kidney failure?', detailPrompt: 'Identify the relative(s), if known.', detailsRequiredOnYes: true },
  { questionId: 'tobacco-use', section: 'SOCIAL', question: 'Do you currently use or have you previously used tobacco in any form (smoking, chewing or other products)?', detailPrompt: 'Specify the product, frequency, duration and whether use is current or former.', detailsRequiredOnYes: true },
  { questionId: 'alcohol-use', section: 'SOCIAL', question: 'Do you currently consume or have you previously consumed alcohol?', detailPrompt: 'Record the usual frequency, amount and whether use is current or former.', detailsRequiredOnYes: true },
  { questionId: 'regular-activity', section: 'SOCIAL', question: 'Do you currently take part in regular physical activity or exercise?', detailPrompt: 'Describe the activity, frequency and approximate duration.', detailsRequiredOnYes: true },
  { questionId: 'medicine-allergy', section: 'ALLERGIES', question: 'Have you ever had an allergy or significant reaction to a medicine?', detailPrompt: 'Record the medicine and the reaction. Do not enter routine medication lists here.', detailsRequiredOnYes: true },
  { questionId: 'other-allergy', section: 'ALLERGIES', question: 'Do you have any known food, latex or other non-medicine allergies?', detailPrompt: 'Specify the allergen and the reaction.', detailsRequiredOnYes: true },
  { questionId: 'pregnancy-breastfeeding', section: 'REPRODUCTIVE', question: 'Are you currently pregnant, possibly pregnant or breastfeeding, where relevant?', detailPrompt: 'Record only the details the patient is comfortable sharing and that are relevant to care.', detailsRequiredOnYes: true },
  { questionId: 'menstrual-history', section: 'REPRODUCTIVE', question: 'Have you experienced significant menstrual irregularity or a relevant reproductive-health concern, where applicable?', detailPrompt: 'Record the concern and approximate duration, if the patient is comfortable sharing.', detailsRequiredOnYes: true },
  { questionId: 'prior-investigations', section: 'PRIOR_INVESTIGATIONS', question: 'Have you had any recent blood tests, scans or other investigations relevant to your current health conditions?', detailPrompt: 'List the test or investigation, approximate date and whether a report is available.', detailsRequiredOnYes: true },
] as const;

export type ApexGeneralHistoryQuestionId = (typeof APEX_GENERAL_HISTORY_QUESTIONS)[number]['questionId'];
