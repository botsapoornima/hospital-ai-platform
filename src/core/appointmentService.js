import { db } from '../db/index.js';
import { newId, newCorrelationId } from '../utils/ids.js';
import { AppError, getHospital, isHospitalActive } from './hospitalService.js';
import { getDoctor } from './doctorService.js';
import { getPatient } from './patientService.js';
import * as scheduling from './schedulingService.js';
import * as integration from '../integration/integrationLayer.js';
import { recordAudit } from './auditService.js';
import { emitEvent } from '../workflows/engine.js';

export async function bookAppointment({ patientId, doctorId, slotId, appointmentType = 'general', idempotencyKey, correlationId }) {
  correlationId = correlationId || newCorrelationId();
  idempotencyKey = idempotencyKey || newId('idem');

  // Idempotency: replaying the same key returns the same appointment rather than double-booking.
  const existing = db.prepare(`SELECT * FROM appointments WHERE idempotency_key = ?`).get(idempotencyKey);
  if (existing) return { appointment: existing, correlationId, replayed: true };

  const doctor = getDoctor(doctorId);
  if (!doctor) throw new AppError('NOT_FOUND', 'Doctor not found');
  const hospital = getHospital(doctor.hospital_id);
  if (!isHospitalActive(hospital.id)) throw new AppError('HOSPITAL_NOT_APPROVED', 'Hospital is not approved');
  const patient = getPatient(patientId);
  if (!patient) throw new AppError('NOT_FOUND', 'Patient not found');

  // Revalidate immediately before reservation - real availability, not a cached view.
  const revalidation = scheduling.revalidateSlot(slotId);
  if (!revalidation.valid) throw new AppError('SLOT_UNAVAILABLE', `Slot is not bookable: ${revalidation.reason}`);

  // Atomic reservation - this is what prevents concurrent double-booking.
  const slot = scheduling.reserveSlot(slotId);

  const appointmentId = newId('appt');
  db.prepare(`
    INSERT INTO appointments (id, hospital_id, doctor_id, patient_id, slot_id, appointment_type, start_at, end_at, status, idempotency_key, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(appointmentId, hospital.id, doctorId, patientId, slotId, appointmentType, slot.start_at, slot.end_at, idempotencyKey, correlationId);
  db.prepare(`INSERT INTO appointment_history (id, appointment_id, from_status, to_status, reason) VALUES (?, ?, NULL, 'pending', 'created')`).run(newId('hist'), appointmentId);

  recordAudit({ correlationId, hospitalId: hospital.id, action: 'appointment.requested', entityType: 'appointment', entityId: appointmentId, metadata: { doctorId, slotId } });

  let appointment = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId);

  try {
    const result = await integration.createAppointmentWithVerification({ hospital, appointment, patient, doctor, correlationId });
    if (result.status === 'confirmed') {
      scheduling.confirmSlotBooking(slotId);
      emitEvent('appointment.confirmed', { appointmentId, hospitalId: hospital.id, patientId, doctorId, correlationId });
    } else {
      // Reconciliation required - slot stays reserved (not released) until resolved,
      // so it can't be double-booked while the true external state is unknown.
      emitEvent('reconciliation.required', { appointmentId, hospitalId: hospital.id, correlationId });
    }
  } catch (err) {
    scheduling.releaseSlot(slotId);
    db.prepare(`UPDATE appointments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(appointmentId);
    throw err;
  }

  appointment = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId);
  return { appointment, correlationId, replayed: false };
}

export async function rescheduleAppointment({ appointmentId, newSlotId, correlationId }) {
  correlationId = correlationId || newCorrelationId();
  const appointment = getAppointment(appointmentId);
  if (!appointment) throw new AppError('NOT_FOUND', 'Appointment not found');
  if (!['confirmed', 'pending'].includes(appointment.status)) {
    throw new AppError('INVALID_STATE', `Cannot reschedule appointment in status ${appointment.status}`);
  }
  const revalidation = scheduling.revalidateSlot(newSlotId);
  if (!revalidation.valid) throw new AppError('SLOT_UNAVAILABLE', `New slot is not bookable: ${revalidation.reason}`);

  const newSlot = scheduling.reserveSlot(newSlotId);
  const hospital = getHospital(appointment.hospital_id);

  const result = await integration.rescheduleAppointmentWithVerification({
    hospital, appointment, newStartAt: newSlot.start_at, newEndAt: newSlot.end_at, correlationId,
  });

  if (result.status === 'rescheduled') {
    scheduling.releaseSlot(appointment.slot_id);
    scheduling.confirmSlotBooking(newSlotId);
    db.prepare(`UPDATE appointments SET slot_id = ? WHERE id = ?`).run(newSlotId, appointmentId);
    emitEvent('appointment.rescheduled', { appointmentId, hospitalId: hospital.id, correlationId });
  } else {
    scheduling.releaseSlot(newSlotId);
  }
  return { appointment: getAppointment(appointmentId), correlationId, result };
}

export async function cancelAppointment({ appointmentId, correlationId, reason }) {
  correlationId = correlationId || newCorrelationId();
  const appointment = getAppointment(appointmentId);
  if (!appointment) throw new AppError('NOT_FOUND', 'Appointment not found');
  if (['cancelled', 'completed'].includes(appointment.status)) {
    return { appointment, correlationId, alreadyTerminal: true };
  }
  const hospital = getHospital(appointment.hospital_id);
  const result = await integration.cancelAppointmentWithVerification({ hospital, appointment, correlationId });

  if (result.status === 'cancelled') {
    scheduling.releaseSlot(appointment.slot_id);
    emitEvent('appointment.cancelled', { appointmentId, hospitalId: hospital.id, correlationId, reason });
  }
  return { appointment: getAppointment(appointmentId), correlationId, result };
}

export function getAppointment(id) {
  return db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
}

export function getAppointmentHistory(id) {
  return db.prepare(`SELECT * FROM appointment_history WHERE appointment_id = ? ORDER BY created_at ASC`).all(id);
}

export function listAppointmentsForHospital(hospitalId, { status } = {}) {
  if (status) return db.prepare(`SELECT * FROM appointments WHERE hospital_id = ? AND status = ? ORDER BY start_at DESC`).all(hospitalId, status);
  return db.prepare(`SELECT * FROM appointments WHERE hospital_id = ? ORDER BY start_at DESC`).all(hospitalId);
}

export function listAppointmentsForDoctor(doctorId) {
  return db.prepare(`SELECT * FROM appointments WHERE doctor_id = ? ORDER BY start_at ASC`).all(doctorId);
}
