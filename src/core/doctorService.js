import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { AppError, isHospitalActive } from './hospitalService.js';

export function createDoctor({ hospitalId, name, specialtyId, departmentId, qualifications, languages = [], consultationTypes = ['in_person'], appointmentDurationMinutes = 30, externalProviderId }) {
  if (!isHospitalActive(hospitalId)) {
    throw new AppError('HOSPITAL_NOT_APPROVED', 'Only approved hospitals can create active doctors');
  }
  const id = newId('doc');
  db.prepare(`
    INSERT INTO doctors (id, hospital_id, name, specialty_id, department_id, qualifications, languages, consultation_types, appointment_duration_minutes, external_provider_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'invited')
  `).run(id, hospitalId, name, specialtyId || null, departmentId || null, qualifications || null, JSON.stringify(languages), JSON.stringify(consultationTypes), appointmentDurationMinutes, externalProviderId || null);

  const calendarId = newId('cal');
  db.prepare(`INSERT INTO calendars (id, doctor_id, is_active) VALUES (?, ?, 1)`).run(calendarId, id);

  return getDoctor(id);
}

export function activateDoctor(doctorId) {
  const doctor = getDoctor(doctorId);
  if (!doctor) throw new AppError('NOT_FOUND', 'Doctor not found');
  db.prepare(`UPDATE doctors SET status = 'active' WHERE id = ?`).run(doctorId);
  return getDoctor(doctorId);
}

export function setDoctorStatus(doctorId, status) {
  if (!['invited', 'active', 'inactive', 'suspended'].includes(status)) {
    throw new AppError('VALIDATION', 'Invalid doctor status');
  }
  db.prepare(`UPDATE doctors SET status = ? WHERE id = ?`).run(status, doctorId);
  return getDoctor(doctorId);
}

export function getDoctor(id) {
  return db.prepare(`SELECT * FROM doctors WHERE id = ?`).get(id);
}

export function listDoctors({ hospitalId, specialtyId, status } = {}) {
  let q = 'SELECT * FROM doctors WHERE 1=1';
  const params = [];
  if (hospitalId) { q += ' AND hospital_id = ?'; params.push(hospitalId); }
  if (specialtyId) { q += ' AND specialty_id = ?'; params.push(specialtyId); }
  if (status) { q += ' AND status = ?'; params.push(status); }
  return db.prepare(q).all(...params);
}

export function getCalendarForDoctor(doctorId) {
  return db.prepare(`SELECT * FROM calendars WHERE doctor_id = ?`).get(doctorId);
}

export function setWorkingHours(calendarId, hoursList) {
  const del = db.prepare(`DELETE FROM working_hours WHERE calendar_id = ?`);
  const ins = db.prepare(`INSERT INTO working_hours (id, calendar_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)`);
  const tx = db.transaction((hours) => {
    del.run(calendarId);
    for (const h of hours) {
      ins.run(newId('wh'), calendarId, h.dayOfWeek, h.startTime, h.endTime);
    }
  });
  tx(hoursList);
  return db.prepare(`SELECT * FROM working_hours WHERE calendar_id = ?`).all(calendarId);
}

export function addBlockedSlot(calendarId, { startAt, endAt, reason }) {
  const id = newId('block');
  db.prepare(`INSERT INTO blocked_slots (id, calendar_id, start_at, end_at, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(id, calendarId, startAt, endAt, reason || null);
  return db.prepare(`SELECT * FROM blocked_slots WHERE id = ?`).get(id);
}

export function createDepartment(hospitalId, name) {
  const id = newId('dept');
  db.prepare(`INSERT INTO departments (id, hospital_id, name) VALUES (?, ?, ?)`).run(id, hospitalId, name);
  return { id, hospitalId, name };
}

export function createSpecialty(hospitalId, name) {
  const id = newId('spec');
  db.prepare(`INSERT INTO specialties (id, hospital_id, name) VALUES (?, ?, ?)`).run(id, hospitalId, name);
  return { id, hospitalId, name };
}

export function listSpecialties(hospitalId) {
  return db.prepare(`SELECT * FROM specialties WHERE hospital_id = ?`).all(hospitalId);
}
