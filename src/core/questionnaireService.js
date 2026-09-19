import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { AppError } from './hospitalService.js';
import { recordAudit } from './auditService.js';

const DISALLOWED_QUESTION_PATTERNS = [
  /diagnos/i, /prescri/i, /medication dose/i, /which drug/i,
];

export function createQuestionnaire({ hospitalId, name, appliesTo = {}, questions }) {
  for (const q of questions) {
    if (DISALLOWED_QUESTION_PATTERNS.some(p => p.test(q.text))) {
      throw new AppError('DISALLOWED_QUESTION', `Question appears clinical/diagnostic and is not permitted: "${q.text}"`);
    }
  }
  const id = newId('qnr');
  db.prepare(`INSERT INTO questionnaires (id, hospital_id, name, applies_to, questions) VALUES (?, ?, ?, ?, ?)`)
    .run(id, hospitalId, name, JSON.stringify(appliesTo), JSON.stringify(questions));
  return getQuestionnaire(id);
}

export function getQuestionnaire(id) {
  return db.prepare(`SELECT * FROM questionnaires WHERE id = ?`).get(id);
}

export function listQuestionnaires(hospitalId) {
  return db.prepare(`SELECT * FROM questionnaires WHERE hospital_id = ?`).all(hospitalId);
}

// Find the best-matching questionnaire for an appointment (by doctor > specialty > type).
export function findApplicableQuestionnaire({ hospitalId, doctorId, specialtyId, appointmentType }) {
  const all = listQuestionnaires(hospitalId);
  for (const q of all) {
    const applies = JSON.parse(q.applies_to);
    if (applies.doctorId && applies.doctorId === doctorId) return q;
  }
  for (const q of all) {
    const applies = JSON.parse(q.applies_to);
    if (applies.specialtyId && applies.specialtyId === specialtyId) return q;
  }
  for (const q of all) {
    const applies = JSON.parse(q.applies_to);
    if (applies.appointmentType && applies.appointmentType === appointmentType) return q;
  }
  return null;
}

export function assignQuestionnaire({ questionnaireId, appointmentId, patientId }) {
  const id = newId('qresp');
  db.prepare(`
    INSERT INTO questionnaire_responses (id, questionnaire_id, appointment_id, patient_id, responses, status)
    VALUES (?, ?, ?, ?, '{}', 'pending')
  `).run(id, questionnaireId, appointmentId, patientId);
  return getResponse(id);
}

export function getResponse(id) {
  return db.prepare(`SELECT * FROM questionnaire_responses WHERE id = ?`).get(id);
}

const URGENT_FLAG_PATTERN = /(chest pain|can't breathe|cannot breathe|suicidal|severe bleeding|unconscious)/i;

export function recordAnswer({ responseId, questionId, answer, correlationId }) {
  const resp = getResponse(responseId);
  if (!resp) throw new AppError('NOT_FOUND', 'Questionnaire response not found');
  const responses = JSON.parse(resp.responses);
  responses[questionId] = answer;
  const escalate = typeof answer === 'string' && URGENT_FLAG_PATTERN.test(answer);
  db.prepare(`UPDATE questionnaire_responses SET responses = ?, status = 'in_progress', escalated = escalated OR ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(responses), escalate ? 1 : 0, responseId);
  if (escalate) {
    recordAudit({ correlationId, action: 'questionnaire.escalation_flagged', entityType: 'questionnaire_response', entityId: responseId, metadata: { questionId } });
  }
  return getResponse(responseId);
}

export function completeQuestionnaire(responseId) {
  db.prepare(`UPDATE questionnaire_responses SET status = 'completed', updated_at = datetime('now') WHERE id = ?`).run(responseId);
  return getResponse(responseId);
}

export function listResponsesForAppointment(appointmentId) {
  return db.prepare(`SELECT * FROM questionnaire_responses WHERE appointment_id = ?`).all(appointmentId);
}
