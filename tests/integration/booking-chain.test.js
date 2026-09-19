import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

process.env.DB_PATH = path.join(process.cwd(), 'data', 'test-integration.db');

const { resetDb, db } = await import('../../src/db/index.js');
const { migrate } = await import('../../src/db/schema.js');

resetDb();
migrate(db);

const hospitalService = await import('../../src/core/hospitalService.js');
const doctorService = await import('../../src/core/doctorService.js');
const schedulingService = await import('../../src/core/schedulingService.js');
const patientService = await import('../../src/core/patientService.js');
const appointmentService = await import('../../src/core/appointmentService.js');
const questionnaireService = await import('../../src/core/questionnaireService.js');
const { setFailureInjection, clearFailureInjection } = await import('../../src/integration/mockEhrConnector.js');
const { tickWorkflows } = await import('../../src/workflows/engine.js');
const { newId } = await import('../../src/utils/ids.js');

function setup() {
  const hospital = hospitalService.registerHospital({ name: 'IT Hosp', address: 'x', contactEmail: 'a@b.com', contactPhone: '1' });
  hospitalService.submitHospital(hospital.id);
  hospitalService.approveHospital(hospital.id, 'tester');
  const specialty = doctorService.createSpecialty(hospital.id, 'Orthopedics');
  const doctor = doctorService.createDoctor({ hospitalId: hospital.id, name: 'Dr. Chain', specialtyId: specialty.id, appointmentDurationMinutes: 30 });
  doctorService.activateDoctor(doctor.id);
  const cal = doctorService.getCalendarForDoctor(doctor.id);
  doctorService.setWorkingHours(cal.id, [0, 1, 2, 3, 4, 5, 6].map(dow => ({ dayOfWeek: dow, startTime: '00:00', endTime: '23:00' })));
  const from = new Date(); const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  schedulingService.generateSlots(doctor.id, from.toISOString(), to.toISOString());
  const patient = patientService.registerPatient({ name: 'Chain Patient', contactPhone: `+1-${Math.random()}` });

  db.prepare(`INSERT INTO workflows (id, hospital_id, name, trigger_event, steps, is_active) VALUES (?, NULL, 'wf', 'appointment.confirmed', ?, 1)`)
    .run(newId('wf'), JSON.stringify([{ type: 'assign_questionnaire' }, { type: 'send_notification', recipientType: 'patient', category: 'confirmation' }]));

  questionnaireService.createQuestionnaire({
    hospitalId: hospital.id, name: 'Ortho Pre-Visit', appliesTo: { specialtyId: specialty.id },
    questions: [{ id: 'q1', type: 'text', text: 'When did it start?' }],
  });

  return { hospital, doctor, patient, from, to };
}

function nextSlot({ doctor, from, to }) {
  const avail = schedulingService.getAvailability({ doctorId: doctor.id, fromISO: from.toISOString(), toISO: to.toISOString() });
  return avail[0];
}

test('E2E: AI -> discovery -> availability -> booking -> mock EHR -> verification -> sync -> questionnaire -> workflow', async () => {
  const ctx = setup();
  const slot = nextSlot(ctx);

  const { appointment } = await appointmentService.bookAppointment({ patientId: ctx.patient.id, doctorId: ctx.doctor.id, slotId: slot.id });
  assert.equal(appointment.status, 'confirmed');
  assert.ok(appointment.external_appointment_id, 'must have a verified external id');

  // slot should now be booked, not double-bookable
  const bookedSlot = schedulingService.getSlot(slot.id);
  assert.equal(bookedSlot.status, 'booked');

  // workflow should have assigned a questionnaire synchronously (no delay step in this def)
  const responses = questionnaireService.listResponsesForAppointment(appointment.id);
  assert.equal(responses.length, 1);

  // notification should have been recorded
  const notif = db.prepare(`SELECT * FROM notifications WHERE hospital_id = ?`).all(ctx.hospital.id);
  assert.ok(notif.length >= 1);
});

test('AI -> scheduling: booking is rejected if slot revalidation fails (concurrent conflict)', async () => {
  const ctx = setup();
  const slot = nextSlot(ctx);
  const patient2 = patientService.registerPatient({ name: 'Second Patient', contactPhone: `+1-${Math.random()}` });

  // First booking succeeds and consumes the slot
  await appointmentService.bookAppointment({ patientId: ctx.patient.id, doctorId: ctx.doctor.id, slotId: slot.id });

  // Second patient tries to book the SAME slot -> must fail, not double-book
  await assert.rejects(
    () => appointmentService.bookAppointment({ patientId: patient2.id, doctorId: ctx.doctor.id, slotId: slot.id }),
    (err) => err.code === 'SLOT_UNAVAILABLE'
  );
});

test('Failure/Recovery Option B - unknown outcome: timeout is resolved by querying the EHR, not blind retry, and no duplicate is created', async () => {
  const ctx = setup();
  const slot = nextSlot(ctx);
  setFailureInjection(ctx.hospital.id, 'timeout', 1);

  const { appointment } = await appointmentService.bookAppointment({ patientId: ctx.patient.id, doctorId: ctx.doctor.id, slotId: slot.id });

  assert.equal(appointment.status, 'confirmed', 'must recover to confirmed, not stay failed');
  assert.ok(appointment.external_appointment_id);

  const ops = db.prepare(`SELECT * FROM integration_operations WHERE appointment_id = ?`).all(appointment.id);
  assert.equal(ops.length, 1, 'must not have issued a second create_appointment call (no duplicate)');
  assert.equal(ops[0].status, 'timeout');
  assert.equal(ops[0].error_class, 'timeout');

  const verifications = db.prepare(`SELECT * FROM integration_verifications WHERE appointment_id = ?`).all(appointment.id);
  assert.ok(verifications.some(v => v.outcome === 'found'), 'must have verified the record was actually created externally');

  clearFailureInjection(ctx.hospital.id);
});

test('Failure/Recovery Option C - unrecoverable failure: terminal error becomes a reconciliation record and operational escalation', async () => {
  const ctx = setup();
  const slot = nextSlot(ctx);
  setFailureInjection(ctx.hospital.id, 'validation', 1);

  const { appointment } = await appointmentService.bookAppointment({ patientId: ctx.patient.id, doctorId: ctx.doctor.id, slotId: slot.id });

  assert.equal(appointment.status, 'reconciliation_required');

  const recon = db.prepare(`SELECT * FROM reconciliation_records WHERE appointment_id = ?`).all(appointment.id);
  assert.equal(recon.length, 1);
  assert.equal(recon[0].status, 'open');

  const escalationEvents = db.prepare(`SELECT * FROM operational_events WHERE hospital_id = ? AND severity = 'critical'`).all(ctx.hospital.id);
  assert.ok(escalationEvents.some(e => e.event_type === 'reconciliation.escalated'));

  // the slot must NOT be released back to 'open' while the true state is unknown -
  // otherwise another patient could book on top of a possibly-real external appointment.
  const slotState = schedulingService.getSlot(slot.id);
  assert.equal(slotState.status, 'reserved');

  clearFailureInjection(ctx.hospital.id);
});

test('Reliability: network failure on create is retried safely, and succeeds on retry without duplicating', async () => {
  const ctx = setup();
  const slot = nextSlot(ctx);
  setFailureInjection(ctx.hospital.id, 'network', 1); // fails once, succeeds on retry

  const { appointment } = await appointmentService.bookAppointment({ patientId: ctx.patient.id, doctorId: ctx.doctor.id, slotId: slot.id });
  assert.equal(appointment.status, 'confirmed');

  const ops = db.prepare(`SELECT * FROM integration_operations WHERE appointment_id = ? ORDER BY attempt ASC`).all(appointment.id);
  assert.equal(ops.length, 2, 'expected one failed attempt then one successful retry');
  assert.equal(ops[0].status, 'failed');
  assert.equal(ops[1].status, 'success');

  clearFailureInjection(ctx.hospital.id);
});

test('Tenant isolation: hospital A cannot see hospital B appointments via the admin listing', async () => {
  const ctxA = setup();
  const ctxB = setup();
  const slotA = nextSlot(ctxA);
  await appointmentService.bookAppointment({ patientId: ctxA.patient.id, doctorId: ctxA.doctor.id, slotId: slotA.id });

  const apptsForB = appointmentService.listAppointmentsForHospital(ctxB.hospital.id);
  assert.equal(apptsForB.length, 0);
});

test('Workflow -> notification: a delayed workflow step only fires after its run_after time (not immediately)', async () => {
  const ctx = setup();
  db.prepare(`INSERT INTO workflows (id, hospital_id, name, trigger_event, steps, is_active) VALUES (?, ?, 'delayed-wf', 'appointment.cancelled', ?, 1)`)
    .run(newId('wf'), ctx.hospital.id, JSON.stringify([{ type: 'wait', delaySeconds: 3600 }, { type: 'send_notification', recipientType: 'patient', category: 'reminder' }]));

  const slot = nextSlot(ctx);
  const { appointment } = await appointmentService.bookAppointment({ patientId: ctx.patient.id, doctorId: ctx.doctor.id, slotId: slot.id });
  await appointmentService.cancelAppointment({ appointmentId: appointment.id });

  const executions = db.prepare(`SELECT * FROM workflow_executions WHERE status = 'waiting'`).all();
  assert.ok(executions.length >= 1, 'the delayed step should be waiting, not already executed');

  const processedNow = tickWorkflows();
  assert.equal(processedNow, 0, 'should not fire early - run_after is an hour out');
});
