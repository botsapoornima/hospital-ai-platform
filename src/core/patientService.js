import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { AppError } from './hospitalService.js';

export function registerPatient({ name, contactPhone, contactEmail, dateOfBirth, communicationPreference = 'sms' }) {
  const id = newId('pat');
  db.prepare(`
    INSERT INTO patients (id, name, contact_phone, contact_email, date_of_birth, communication_preference, external_patient_id_map)
    VALUES (?, ?, ?, ?, ?, ?, '{}')
  `).run(id, name, contactPhone || null, contactEmail || null, dateOfBirth || null, communicationPreference);
  db.prepare(`INSERT INTO user_context (patient_id, preferences) VALUES (?, '{}')`).run(id);
  return getPatient(id);
}

export function getPatient(id) {
  return db.prepare(`SELECT * FROM patients WHERE id = ?`).get(id);
}

export function findPatientByContact({ contactPhone, contactEmail }) {
  if (contactPhone) return db.prepare(`SELECT * FROM patients WHERE contact_phone = ?`).get(contactPhone);
  if (contactEmail) return db.prepare(`SELECT * FROM patients WHERE contact_email = ?`).get(contactEmail);
  return null;
}

// Only relevant, minimized preferences are retained - never arbitrary clinical content.
const ALLOWED_PREFERENCE_KEYS = new Set(['preferredTimeOfDay', 'preferredDoctorId', 'preferredHospitalId', 'communicationChannel', 'language']);

export function updatePreferences(patientId, preferences) {
  const existingRow = db.prepare(`SELECT preferences FROM user_context WHERE patient_id = ?`).get(patientId);
  if (!existingRow) throw new AppError('NOT_FOUND', 'Patient context not found');
  const existing = JSON.parse(existingRow.preferences);
  const filtered = {};
  for (const [k, v] of Object.entries(preferences)) {
    if (ALLOWED_PREFERENCE_KEYS.has(k)) filtered[k] = v;
  }
  const merged = { ...existing, ...filtered };
  db.prepare(`UPDATE user_context SET preferences = ? WHERE patient_id = ?`).run(JSON.stringify(merged), patientId);
  return merged;
}

export function getPreferences(patientId) {
  const row = db.prepare(`SELECT preferences FROM user_context WHERE patient_id = ?`).get(patientId);
  return row ? JSON.parse(row.preferences) : {};
}

export function listAppointmentsForPatient(patientId) {
  return db.prepare(`
    SELECT a.*, d.name as doctor_name, h.name as hospital_name
    FROM appointments a
    JOIN doctors d ON d.id = a.doctor_id
    JOIN hospitals h ON h.id = a.hospital_id
    WHERE a.patient_id = ?
    ORDER BY a.start_at DESC
  `).all(patientId);
}
