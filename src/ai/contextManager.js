import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';

export function startConversation({ patientId, channel = 'web_chat' }) {
  const id = newId('conv');
  db.prepare(`INSERT INTO ai_conversations (id, patient_id, channel, status) VALUES (?, ?, ?, 'active')`).run(id, patientId || null, channel);
  db.prepare(`INSERT INTO ai_context (conversation_id, slate) VALUES (?, '{}')`).run(id);
  return getConversation(id);
}

export function getConversation(id) {
  return db.prepare(`SELECT * FROM ai_conversations WHERE id = ?`).get(id);
}

export function endConversation(id, status = 'completed') {
  db.prepare(`UPDATE ai_conversations SET status = ?, ended_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function addMessage(conversationId, role, content) {
  db.prepare(`INSERT INTO ai_messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)`).run(newId('msg'), conversationId, role, content);
}

export function getMessages(conversationId) {
  return db.prepare(`SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC`).all(conversationId);
}

export function getContext(conversationId) {
  const row = db.prepare(`SELECT * FROM ai_context WHERE conversation_id = ?`).get(conversationId);
  if (!row) return null;
  return { ...row, slate: JSON.parse(row.slate) };
}

export function updateContext(conversationId, patch) {
  const current = getContext(conversationId) || { slate: {} };
  const merged = { ...current, ...patch, slate: { ...current.slate, ...(patch.slate || {}) } };
  db.prepare(`
    UPDATE ai_context SET intent = ?, hospital_id = ?, doctor_id = ?, slot_id = ?, appointment_id = ?, slate = ?, updated_at = datetime('now')
    WHERE conversation_id = ?
  `).run(merged.intent || null, merged.hospital_id || null, merged.doctor_id || null, merged.slot_id || null, merged.appointment_id || null, JSON.stringify(merged.slate || {}), conversationId);
  return getContext(conversationId);
}

export function linkPatient(conversationId, patientId) {
  db.prepare(`UPDATE ai_conversations SET patient_id = ? WHERE id = ?`).run(patientId, conversationId);
}
