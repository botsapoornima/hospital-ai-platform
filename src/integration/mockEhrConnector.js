// Mock EHR / external healthcare system connector.
//
// This is the ONLY module that knows anything vendor-specific. A real connector
// (e.g. Epic, Cerner, athenahealth) would implement this exact same interface
// (createAppointment, updateAppointment, cancelAppointment, getAppointment,
// lookupPatient, lookupProvider) and be swapped in without touching the
// integration layer, capabilities, or AI logic above it.
//
// It maintains its own tiny in-memory "external system" state, independent of
// our platform DB, so that verification queries are meaningful (we ask IT what
// it thinks is true, we don't just trust our own write).

const externalAppointments = new Map(); // externalId -> record
const externalPatients = new Map();
const externalProviders = new Map();
let seq = 1;

// Per-hospital failure injection, used only to demonstrate the required
// failure/recovery scenarios (PRD §28). In a real connector this would be
// actual network/timeout behavior, not a dial.
const failureInjection = new Map(); // hospitalId -> { mode, timesRemaining }

export function setFailureInjection(hospitalId, mode, times = 1) {
  failureInjection.set(hospitalId, { mode, timesRemaining: times });
}

export function clearFailureInjection(hospitalId) {
  failureInjection.delete(hospitalId);
}

// Only consumes the injected failure if the calling operation actually acts on that
// mode - e.g. a lookup call that only handles 'outage' must not silently burn a
// 'timeout' injection meant for the create call that follows it.
function maybeFail(hospitalId, relevantModes) {
  const inj = failureInjection.get(hospitalId);
  if (!inj || inj.timesRemaining <= 0) return null;
  if (!relevantModes.includes(inj.mode)) return null;
  inj.timesRemaining -= 1;
  if (inj.timesRemaining === 0) failureInjection.delete(hospitalId);
  return inj.mode;
}

function delay(ms) {
  // synchronous-ish sleep is avoided; connector API is async so callers must await.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function lookupPatient(hospitalId, { internalPatientId, name, dateOfBirth }) {
  await delay(20);
  const mode = maybeFail(hospitalId, ['outage']);
  if (mode === 'outage') throw new EhrError('outage', 'External system unavailable');
  // Auto-provision on first lookup for demo purposes (a real EHR would already have the record).
  let externalId = [...externalPatients.entries()].find(([, p]) => p.internalPatientId === internalPatientId)?.[0];
  if (!externalId) {
    externalId = `EXTPAT-${seq++}`;
    externalPatients.set(externalId, { internalPatientId, name, dateOfBirth });
  }
  return { externalPatientId: externalId };
}

export async function lookupProvider(hospitalId, { internalDoctorId, name }) {
  await delay(20);
  let externalId = [...externalProviders.entries()].find(([, p]) => p.internalDoctorId === internalDoctorId)?.[0];
  if (!externalId) {
    externalId = `EXTPROV-${seq++}`;
    externalProviders.set(externalId, { internalDoctorId, name });
  }
  return { externalProviderId: externalId };
}

export async function createAppointment(hospitalId, { externalPatientId, externalProviderId, startAt, endAt, appointmentType, idempotencyKey }) {
  const mode = maybeFail(hospitalId, ['network', 'auth', 'rate_limit', 'validation', 'timeout']);

  // Duplicate-request protection: EHR honors idempotency keys.
  const existing = [...externalAppointments.values()].find(a => a.idempotencyKey === idempotencyKey);
  if (existing) {
    await delay(20);
    return { externalAppointmentId: existing.id, status: existing.status, duplicate: true };
  }

  if (mode === 'network') { await delay(50); throw new EhrError('network', 'Network failure calling external system'); }
  if (mode === 'auth') { await delay(20); throw new EhrError('auth', 'External authentication failed'); }
  if (mode === 'rate_limit') { await delay(20); throw new EhrError('rate_limit', 'External system rate limited the request'); }
  if (mode === 'validation') { await delay(20); throw new EhrError('validation', 'External system rejected payload'); }

  if (mode === 'timeout') {
    // The critical "unknown outcome" case: the external system actually DID create
    // the record, but the response never made it back to us. We simulate this by
    // still writing the record, then throwing a timeout to the caller.
    const externalId = `EXTAPT-${seq++}`;
    externalAppointments.set(externalId, {
      id: externalId, externalPatientId, externalProviderId, startAt, endAt, appointmentType,
      status: 'booked', idempotencyKey,
    });
    await delay(80);
    throw new EhrError('timeout', 'External system did not respond in time');
  }

  await delay(40);
  const externalId = `EXTAPT-${seq++}`;
  externalAppointments.set(externalId, {
    id: externalId, externalPatientId, externalProviderId, startAt, endAt, appointmentType,
    status: 'booked', idempotencyKey,
  });
  return { externalAppointmentId: externalId, status: 'booked', duplicate: false };
}

export async function getAppointment(hospitalId, externalAppointmentId) {
  await delay(15);
  const record = externalAppointments.get(externalAppointmentId);
  return record ? { found: true, record } : { found: false };
}

// Used during reconciliation when we don't even have an external ID yet (the create
// call itself timed out) - search by the idempotency key we sent.
export async function findAppointmentByIdempotencyKey(hospitalId, idempotencyKey) {
  await delay(15);
  const record = [...externalAppointments.values()].find(a => a.idempotencyKey === idempotencyKey);
  return record ? { found: true, record } : { found: false };
}

export async function updateAppointment(hospitalId, externalAppointmentId, { startAt, endAt }) {
  const mode = maybeFail(hospitalId, ['network']);
  if (mode === 'network') throw new EhrError('network', 'Network failure calling external system');
  await delay(30);
  const record = externalAppointments.get(externalAppointmentId);
  if (!record) throw new EhrError('mapping', 'External appointment not found');
  record.startAt = startAt;
  record.endAt = endAt;
  record.status = 'rescheduled';
  return { externalAppointmentId, status: 'rescheduled' };
}

export async function cancelAppointment(hospitalId, externalAppointmentId) {
  const mode = maybeFail(hospitalId, ['network']);
  if (mode === 'network') throw new EhrError('network', 'Network failure calling external system');
  await delay(30);
  const record = externalAppointments.get(externalAppointmentId);
  if (!record) throw new EhrError('mapping', 'External appointment not found');
  record.status = 'cancelled';
  return { externalAppointmentId, status: 'cancelled' };
}

export class EhrError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.errorClass = errorClass; // timeout|network|auth|authz|rate_limit|outage|validation|mapping
  }
}
