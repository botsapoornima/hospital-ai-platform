import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { AppError } from './hospitalService.js';
import { getDoctor, getCalendarForDoctor } from './doctorService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Materialize concrete slot rows for a doctor between two ISO dates, based on
// recurring working hours, minus blocked periods. Idempotent (skips slots that
// already exist for that doctor+start_at, enforced by a UNIQUE constraint too).
export function generateSlots(doctorId, fromISO, toISO, appointmentType = 'general') {
  const doctor = getDoctor(doctorId);
  if (!doctor) throw new AppError('NOT_FOUND', 'Doctor not found');
  const calendar = getCalendarForDoctor(doctorId);
  if (!calendar || !calendar.is_active) throw new AppError('CALENDAR_INACTIVE', 'Calendar is not active');

  const workingHours = db.prepare(`SELECT * FROM working_hours WHERE calendar_id = ?`).all(calendar.id);
  const blocked = db.prepare(`SELECT * FROM blocked_slots WHERE calendar_id = ?`).all(calendar.id);
  const durationMs = doctor.appointment_duration_minutes * 60 * 1000;

  const from = new Date(fromISO);
  const to = new Date(toISO);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO slots (id, calendar_id, doctor_id, start_at, end_at, appointment_type, status, version)
    VALUES (?, ?, ?, ?, ?, ?, 'open', 0)
  `);

  const created = [];
  const tx = db.transaction(() => {
    for (let day = new Date(from); day <= to; day = new Date(day.getTime() + DAY_MS)) {
      const dow = day.getUTCDay();
      const dayHours = workingHours.filter(h => h.day_of_week === dow);
      for (const wh of dayHours) {
        const [sh, sm] = wh.start_time.split(':').map(Number);
        const [eh, em] = wh.end_time.split(':').map(Number);
        let cursor = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), sh, sm));
        const windowEnd = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), eh, em));
        while (cursor.getTime() + durationMs <= windowEnd.getTime()) {
          const slotStart = cursor;
          const slotEnd = new Date(cursor.getTime() + durationMs);
          const isBlocked = blocked.some(b => overlaps(slotStart.getTime(), slotEnd.getTime(), new Date(b.start_at).getTime(), new Date(b.end_at).getTime()));
          if (!isBlocked) {
            const id = newId('slot');
            insert.run(id, calendar.id, doctorId, slotStart.toISOString(), slotEnd.toISOString(), appointmentType);
            created.push(id);
          }
          cursor = slotEnd;
        }
      }
    }
  });
  tx();
  return created.length;
}

// Real availability query. Never invents slots - only returns materialized, open rows
// that pass every eligibility rule from PRD §7.
export function getAvailability({ doctorId, hospitalId, specialtyId, fromISO, toISO, appointmentType }) {
  let doctorFilter = '';
  const params = {};
  if (doctorId) { doctorFilter += ' AND d.id = @doctorId'; params.doctorId = doctorId; }
  if (hospitalId) { doctorFilter += ' AND d.hospital_id = @hospitalId'; params.hospitalId = hospitalId; }
  if (specialtyId) { doctorFilter += ' AND d.specialty_id = @specialtyId'; params.specialtyId = specialtyId; }

  params.fromISO = fromISO;
  params.toISO = toISO;

  let typeFilter = '';
  if (appointmentType) { typeFilter = ' AND s.appointment_type = @appointmentType'; params.appointmentType = appointmentType; }

  const rows = db.prepare(`
    SELECT s.*, d.name as doctor_name, d.hospital_id, d.appointment_duration_minutes
    FROM slots s
    JOIN doctors d ON d.id = s.doctor_id
    JOIN calendars c ON c.id = s.calendar_id
    WHERE s.status = 'open'
      AND d.status = 'active'
      AND c.is_active = 1
      AND s.start_at >= @fromISO AND s.start_at <= @toISO
      ${doctorFilter} ${typeFilter}
    ORDER BY s.start_at ASC
  `).all(params);
  return rows;
}

export function getSlot(slotId) {
  return db.prepare(`SELECT * FROM slots WHERE id = ?`).get(slotId);
}

// Atomically reserve a slot to prevent concurrent double-booking.
// Uses a conditional UPDATE (status must still be 'open') as the concurrency guard -
// only one caller can win the race even under concurrent requests.
export function reserveSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot) throw new AppError('NOT_FOUND', 'Slot not found');

  const result = db.prepare(`
    UPDATE slots SET status = 'reserved', version = version + 1
    WHERE id = ? AND status = 'open'
  `).run(slotId);

  if (result.changes === 0) {
    throw new AppError('SLOT_CONFLICT', 'Slot is no longer available (already reserved or booked)');
  }
  return getSlot(slotId);
}

export function confirmSlotBooking(slotId) {
  const result = db.prepare(`UPDATE slots SET status = 'booked', version = version + 1 WHERE id = ? AND status = 'reserved'`).run(slotId);
  if (result.changes === 0) throw new AppError('INVALID_STATE', 'Slot was not in reserved state');
  return getSlot(slotId);
}

export function releaseSlot(slotId) {
  db.prepare(`UPDATE slots SET status = 'open', version = version + 1 WHERE id = ? AND status IN ('reserved','booked')`).run(slotId);
  return getSlot(slotId);
}

// Revalidate immediately before booking - re-checks all eligibility rules, not just status.
export function revalidateSlot(slotId) {
  const slot = getSlot(slotId);
  if (!slot) return { valid: false, reason: 'not_found' };
  if (slot.status !== 'open') return { valid: false, reason: 'not_open' };
  const doctor = getDoctor(slot.doctor_id);
  if (!doctor || doctor.status !== 'active') return { valid: false, reason: 'doctor_inactive' };
  const calendar = getCalendarForDoctor(slot.doctor_id);
  if (!calendar || !calendar.is_active) return { valid: false, reason: 'calendar_inactive' };
  const blocked = db.prepare(`SELECT * FROM blocked_slots WHERE calendar_id = ?`).all(calendar.id);
  const isBlocked = blocked.some(b => overlaps(new Date(slot.start_at).getTime(), new Date(slot.end_at).getTime(), new Date(b.start_at).getTime(), new Date(b.end_at).getTime()));
  if (isBlocked) return { valid: false, reason: 'blocked' };
  return { valid: true };
}
