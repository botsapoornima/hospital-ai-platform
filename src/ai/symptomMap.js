// Administrative routing only: maps a patient's own words to a specialty so we can
// search for the right kind of doctor. This is NOT a diagnosis - we are just
// reflecting "you mentioned shoulder pain" -> "orthopedics handles that" the same
// way a front-desk receptionist would.
export const SYMPTOM_TO_SPECIALTY = [
  { keywords: ['shoulder', 'knee', 'joint', 'bone', 'fracture', 'back pain', 'sports injury'], specialty: 'Orthopedics' },
  { keywords: ['skin', 'rash', 'acne', 'mole'], specialty: 'Dermatology' },
  { keywords: ['heart', 'chest discomfort', 'palpitation', 'blood pressure'], specialty: 'Cardiology' },
  { keywords: ['child', 'kid', 'baby', 'infant', 'pediatric'], specialty: 'Pediatrics' },
  { keywords: ['tooth', 'teeth', 'dental', 'gum'], specialty: 'Dentistry' },
  { keywords: ['eye', 'vision', 'blurry'], specialty: 'Ophthalmology' },
  { keywords: ['anxiety', 'depression', 'stress', 'mental health', 'sleep'], specialty: 'Psychiatry' },
  { keywords: ['stomach', 'digestive', 'nausea', 'abdominal'], specialty: 'Gastroenterology' },
  { keywords: ['fever', 'cold', 'flu', 'checkup', 'general', 'annual'], specialty: 'General Medicine' },
];

export function inferSpecialty(text) {
  const lower = text.toLowerCase();
  for (const entry of SYMPTOM_TO_SPECIALTY) {
    if (entry.keywords.some(k => lower.includes(k))) return entry.specialty;
  }
  return null;
}

// Urgent/clinical red-flag terms that should route to escalation rather than
// continuing normal scheduling conversation.
const URGENT_PATTERNS = [/chest pain/i, /can'?t breathe/i, /severe bleeding/i, /suicidal/i, /unconscious/i, /stroke/i];
export function containsUrgentSignal(text) {
  return URGENT_PATTERNS.some(p => p.test(text));
}

// Requests the AI must refuse per PRD §20 (diagnose/prescribe/treatment/medication).
const CLINICAL_REQUEST_PATTERNS = [
  /what('| i)?s wrong with me/i, /do i have/i, /diagnos/i, /prescri/i,
  /what medication/i, /change my (dose|medication)/i, /should i take/i, /is it cancer/i,
];
export function isClinicalRequest(text) {
  return CLINICAL_REQUEST_PATTERNS.some(p => p.test(text));
}
