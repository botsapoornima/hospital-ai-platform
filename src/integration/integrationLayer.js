import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import * as ehr from './mockEhrConnector.js';
import { recordOperationalEvent, recordAudit } from '../core/auditService.js';

const MAX_CREATE_RETRIES = 2;

function upsertMapping(hospitalId, entityType, internalId, externalId) {
  db.prepare(`
    INSERT INTO external_identifier_mappings (id, hospital_id, entity_type, internal_id, external_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(hospital_id, entity_type, internal_id) DO UPDATE SET external_id = excluded.external_id
  `).run(newId('map'), hospitalId, entityType, internalId, externalId);
}

export function getMapping(hospitalId, entityType, internalId) {
  return db.prepare(`
    SELECT external_id FROM external_identifier_mappings WHERE hospital_id = ? AND entity_type = ? AND internal_id = ?
  `).get(hospitalId, entityType, internalId)?.external_id;
}

function logIntegrationOperation({ hospitalId, appointmentId, correlationId, operationType, idempotencyKey, requestPayload, responsePayload, status, attempt, errorClass }) {
  const id = newId('intop');
  db.prepare(`
    INSERT INTO integration_operations
      (id, hospital_id, appointment_id, correlation_id, operation_type, idempotency_key, request_payload, response_payload, status, attempt, error_class)
    VALUES (@id, @hospitalId, @appointmentId, @correlationId, @operationType, @idempotencyKey, @requestPayload, @responsePayload, @status, @attempt, @errorClass)
  `).run({
    id, hospitalId, appointmentId: appointmentId || null, correlationId, operationType,
    idempotencyKey: idempotencyKey || null,
    requestPayload: JSON.stringify(requestPayload || {}),
    responsePayload: JSON.stringify(responsePayload || {}),
    status, attempt, errorClass: errorClass || null,
  });
  return id;
}

function updateIntegrationOperation(id, patch) {
  const sets = Object.keys(patch).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE integration_operations SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ id, ...patch });
}

function recordVerification({ integrationOperationId, appointmentId, verified, externalState, outcome }) {
  db.prepare(`
    INSERT INTO integration_verifications (id, integration_operation_id, appointment_id, verified, external_state, outcome)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(newId('verif'), integrationOperationId, appointmentId, verified ? 1 : 0, JSON.stringify(externalState || {}), outcome);
}

function openReconciliation({ hospitalId, appointmentId, integrationOperationId, reason }) {
  const id = newId('recon');
  db.prepare(`
    INSERT INTO reconciliation_records (id, hospital_id, appointment_id, integration_operation_id, reason, status)
    VALUES (?, ?, ?, ?, ?, 'open')
  `).run(id, hospitalId, appointmentId, integrationOperationId, reason);
  recordOperationalEvent({ hospitalId, eventType: 'reconciliation.required', severity: 'error', metadata: { appointmentId, reason } });
  return id;
}

function markAppointment(appointmentId, status, externalAppointmentId) {
  const fromRow = db.prepare(`SELECT status FROM appointments WHERE id = ?`).get(appointmentId);
  db.prepare(`
    UPDATE appointments SET status = ?, external_appointment_id = COALESCE(?, external_appointment_id), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, externalAppointmentId || null, appointmentId);
  db.prepare(`
    INSERT INTO appointment_history (id, appointment_id, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?)
  `).run(newId('hist'), appointmentId, fromRow?.status, status, 'integration_sync');
}

// Ensures internal<->external mappings exist for patient and doctor before booking.
export async function ensureMappings(hospitalId, { patient, doctor }) {
  let externalPatientId = getMapping(hospitalId, 'patient', patient.id);
  if (!externalPatientId) {
    const res = await ehr.lookupPatient(hospitalId, { internalPatientId: patient.id, name: patient.name, dateOfBirth: patient.date_of_birth });
    externalPatientId = res.externalPatientId;
    upsertMapping(hospitalId, 'patient', patient.id, externalPatientId);
  }
  let externalProviderId = getMapping(hospitalId, 'doctor', doctor.id);
  if (!externalProviderId) {
    const res = await ehr.lookupProvider(hospitalId, { internalDoctorId: doctor.id, name: doctor.name });
    externalProviderId = res.externalProviderId;
    upsertMapping(hospitalId, 'doctor', doctor.id, externalProviderId);
  }
  return { externalPatientId, externalProviderId };
}

/**
 * The core verified-booking flow (PRD §13):
 * create -> external response -> verify external record -> synchronize internal state -> confirm.
 * On timeout/unknown outcome: query the external system rather than blindly retrying,
 * to avoid duplicate bookings. Unresolved cases become reconciliation records.
 */
export async function createAppointmentWithVerification({ hospital, appointment, patient, doctor, correlationId }) {
  const hospitalId = hospital.id;
  const { externalPatientId, externalProviderId } = await ensureMappings(hospitalId, { patient, doctor });

  let attempt = 1;
  let lastErrorClass = null;

  while (attempt <= MAX_CREATE_RETRIES + 1) {
    const opId = logIntegrationOperation({
      hospitalId, appointmentId: appointment.id, correlationId, operationType: 'create_appointment',
      idempotencyKey: appointment.idempotency_key,
      requestPayload: { externalPatientId, externalProviderId, startAt: appointment.start_at, endAt: appointment.end_at, appointmentType: appointment.appointment_type },
      status: 'pending', attempt,
    });

    try {
      const res = await ehr.createAppointment(hospitalId, {
        externalPatientId, externalProviderId, startAt: appointment.start_at, endAt: appointment.end_at,
        appointmentType: appointment.appointment_type, idempotencyKey: appointment.idempotency_key,
      });
      updateIntegrationOperation(opId, { status: 'success', response_payload: JSON.stringify(res) });

      // Verify: don't trust our own write - ask the external system what it has.
      const verify = await ehr.getAppointment(hospitalId, res.externalAppointmentId);
      recordVerification({ integrationOperationId: opId, appointmentId: appointment.id, verified: verify.found, externalState: verify.record, outcome: verify.found ? 'found' : 'not_found' });

      if (verify.found) {
        upsertMapping(hospitalId, 'appointment', appointment.id, res.externalAppointmentId);
        markAppointment(appointment.id, 'confirmed', res.externalAppointmentId);
        recordAudit({ correlationId, hospitalId, action: 'appointment.confirmed', entityType: 'appointment', entityId: appointment.id, metadata: { externalAppointmentId: res.externalAppointmentId, attempt } });
        return { status: 'confirmed', externalAppointmentId: res.externalAppointmentId, attempt };
      } else {
        // Created but immediately unverifiable - treat as unknown outcome.
        markAppointment(appointment.id, 'reconciliation_required', null);
        const reconId = openReconciliation({ hospitalId, appointmentId: appointment.id, integrationOperationId: opId, reason: 'create_succeeded_but_unverifiable' });
        return { status: 'reconciliation_required', reconciliationId: reconId, attempt };
      }
    } catch (err) {
      const errorClass = err.errorClass || 'unknown';
      lastErrorClass = errorClass;
      updateIntegrationOperation(opId, { status: errorClass === 'timeout' ? 'timeout' : 'failed', error_class: errorClass });
      recordOperationalEvent({ correlationId, hospitalId, eventType: `ehr.${errorClass}`, severity: 'warning', metadata: { appointmentId: appointment.id, attempt } });

      if (errorClass === 'timeout' || errorClass === 'network') {
        // UNKNOWN OUTCOME PATH: query the external system by idempotency key before
        // ever retrying the create call, so we never produce a duplicate appointment.
        const found = await ehr.findAppointmentByIdempotencyKey(hospitalId, appointment.idempotency_key);
        recordVerification({ integrationOperationId: opId, appointmentId: appointment.id, verified: found.found, externalState: found.record, outcome: found.found ? 'found' : 'not_found' });

        if (found.found) {
          // It actually succeeded on the other side - sync safely, do NOT create a duplicate.
          upsertMapping(hospitalId, 'appointment', appointment.id, found.record.id);
          markAppointment(appointment.id, 'confirmed', found.record.id);
          recordOperationalEvent({ correlationId, hospitalId, eventType: 'reconciliation.auto_resolved', severity: 'info', metadata: { appointmentId: appointment.id, externalAppointmentId: found.record.id } });
          recordAudit({ correlationId, hospitalId, action: 'appointment.confirmed_after_recovery', entityType: 'appointment', entityId: appointment.id, metadata: { externalAppointmentId: found.record.id, recoveredFrom: errorClass } });
          return { status: 'confirmed', externalAppointmentId: found.record.id, attempt, recoveredFrom: errorClass };
        }
        // Not found externally -> safe to retry the create (still same idempotency key).
        attempt += 1;
        if (attempt <= MAX_CREATE_RETRIES + 1) continue;
      } else {
        // Terminal error classes (auth, validation, rate_limit, outage, mapping) - do not retry blindly.
        break;
      }
      break;
    }
  }

  // Exhausted retries / terminal error / genuinely unresolved -> reconciliation + escalation.
  markAppointment(appointment.id, 'reconciliation_required', null);
  const lastOp = db.prepare(`SELECT id FROM integration_operations WHERE appointment_id = ? ORDER BY created_at DESC LIMIT 1`).get(appointment.id);
  const reconId = openReconciliation({ hospitalId, appointmentId: appointment.id, integrationOperationId: lastOp?.id, reason: `unresolved_after_retries:${lastErrorClass}` });
  recordOperationalEvent({ correlationId, hospitalId, eventType: 'reconciliation.escalated', severity: 'critical', metadata: { appointmentId: appointment.id, errorClass: lastErrorClass } });
  return { status: 'reconciliation_required', reconciliationId: reconId, errorClass: lastErrorClass };
}

export async function cancelAppointmentWithVerification({ hospital, appointment, correlationId }) {
  const hospitalId = hospital.id;
  const externalAppointmentId = getMapping(hospitalId, 'appointment', appointment.id);
  const opId = logIntegrationOperation({ hospitalId, appointmentId: appointment.id, correlationId, operationType: 'cancel_appointment', requestPayload: { externalAppointmentId }, status: 'pending', attempt: 1 });
  try {
    if (externalAppointmentId) {
      await ehr.cancelAppointment(hospitalId, externalAppointmentId);
    }
    updateIntegrationOperation(opId, { status: 'success' });
    const verify = externalAppointmentId ? await ehr.getAppointment(hospitalId, externalAppointmentId) : { found: false };
    recordVerification({ integrationOperationId: opId, appointmentId: appointment.id, verified: !!verify.found, externalState: verify.record, outcome: verify.found ? 'found' : 'not_found' });
    markAppointment(appointment.id, 'cancelled', null);
    recordAudit({ correlationId, hospitalId, action: 'appointment.cancelled', entityType: 'appointment', entityId: appointment.id, metadata: {} });
    return { status: 'cancelled' };
  } catch (err) {
    updateIntegrationOperation(opId, { status: 'failed', error_class: err.errorClass || 'unknown' });
    markAppointment(appointment.id, 'reconciliation_required', null);
    const reconId = openReconciliation({ hospitalId, appointmentId: appointment.id, integrationOperationId: opId, reason: `cancel_failed:${err.errorClass || 'unknown'}` });
    return { status: 'reconciliation_required', reconciliationId: reconId };
  }
}

export async function rescheduleAppointmentWithVerification({ hospital, appointment, newStartAt, newEndAt, correlationId }) {
  const hospitalId = hospital.id;
  const externalAppointmentId = getMapping(hospitalId, 'appointment', appointment.id);
  const opId = logIntegrationOperation({ hospitalId, appointmentId: appointment.id, correlationId, operationType: 'reschedule_appointment', requestPayload: { externalAppointmentId, newStartAt, newEndAt }, status: 'pending', attempt: 1 });
  try {
    if (externalAppointmentId) {
      await ehr.updateAppointment(hospitalId, externalAppointmentId, { startAt: newStartAt, endAt: newEndAt });
    }
    updateIntegrationOperation(opId, { status: 'success' });
    const verify = externalAppointmentId ? await ehr.getAppointment(hospitalId, externalAppointmentId) : { found: false };
    recordVerification({ integrationOperationId: opId, appointmentId: appointment.id, verified: !!verify.found, externalState: verify.record, outcome: verify.found ? 'found' : 'not_found' });
    db.prepare(`UPDATE appointments SET start_at = ?, end_at = ?, status = 'rescheduled', updated_at = datetime('now') WHERE id = ?`).run(newStartAt, newEndAt, appointment.id);
    db.prepare(`INSERT INTO appointment_history (id, appointment_id, from_status, to_status, reason) VALUES (?, ?, ?, 'rescheduled', 'integration_sync')`).run(newId('hist'), appointment.id, appointment.status);
    recordAudit({ correlationId, hospitalId, action: 'appointment.rescheduled', entityType: 'appointment', entityId: appointment.id, metadata: {} });
    return { status: 'rescheduled' };
  } catch (err) {
    updateIntegrationOperation(opId, { status: 'failed', error_class: err.errorClass || 'unknown' });
    const reconId = openReconciliation({ hospitalId, appointmentId: appointment.id, integrationOperationId: opId, reason: `reschedule_failed:${err.errorClass || 'unknown'}` });
    return { status: 'reconciliation_required', reconciliationId: reconId };
  }
}
