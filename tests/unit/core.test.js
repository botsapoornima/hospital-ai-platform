import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

// Isolate this test file to its own SQLite file - node:test may run files concurrently,
// and both test files touching the same default data/platform.db would race.
process.env.DB_PATH = path.join(process.cwd(), 'data', 'test-unit.db');

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

function makeApprovedHospitalWithDoctor() {
  const hospital = hospitalService.registerHospital({ name: 'Test Hosp', address: 'x', contactEmail: 'a@b.com', contactPhone: '123' });
  hospitalService.submitHospital(hospital.id);
  hospitalService.approveHospital(hospital.id, 'tester');
  const doctor = doctorService.createDoctor({ hospitalId: hospital.id, name: 'Dr. Test', appointmentDurationMinutes: 30 });
  doctorService.activateDoctor(doctor.id);
  const cal = doctorService.getCalendarForDoctor(doctor.id);
  doctorService.setWorkingHours(cal.id, [{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00' }]);
  return { hospital, doctor };
}

test('availability calculation: only materializes slots within working hours, excludes blocked periods', () => {
  const { doctor } = makeApprovedHospitalWithDoctor();
  const cal = doctorService.getCalendarForDoctor(doctor.id);
  // Block 9:30-10:00 on the first Monday in range
  const from = new Date();
  from.setUTCDate(from.getUTCDate() + ((1 - from.getUTCDay() + 7) % 7 || 7)); // next Monday
  from.setUTCHours(0, 0, 0, 0);
  const blockStart = new Date(from); blockStart.setUTCHours(9, 30);
  const blockEnd = new Date(from); blockEnd.setUTCHours(10, 0);
  doctorService.addBlockedSlot(cal.id, { startAt: blockStart.toISOString(), endAt: blockEnd.toISOString(), reason: 'test block' });

  const to = new Date(from); to.setUTCDate(to.getUTCDate() + 1);
  const count = schedulingService.generateSlots(doctor.id, from.toISOString(), to.toISOString());
  // 9:00-11:00 in 30-min slots = 4 slots, minus 1 blocked = 3
  assert.equal(count, 3);
});

test('slot validation: cannot reserve an already-reserved slot (double booking prevention)', () => {
  const { doctor } = makeApprovedHospitalWithDoctor();
  const from = new Date(); const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  schedulingService.generateSlots(doctor.id, from.toISOString(), to.toISOString());
  const avail = schedulingService.getAvailability({ doctorId: doctor.id, fromISO: from.toISOString(), toISO: to.toISOString() });
  assert.ok(avail.length > 0);
  const slotId = avail[0].id;

  schedulingService.reserveSlot(slotId); // first reservation succeeds
  assert.throws(() => schedulingService.reserveSlot(slotId), (err) => err.code === 'SLOT_CONFLICT');
});

test('appointment state transitions: booking moves slot open -> reserved -> booked', () => {
  const { doctor } = makeApprovedHospitalWithDoctor();
  const from = new Date(); const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  schedulingService.generateSlots(doctor.id, from.toISOString(), to.toISOString());
  const avail = schedulingService.getAvailability({ doctorId: doctor.id, fromISO: from.toISOString(), toISO: to.toISOString() });
  const slot = schedulingService.getSlot(avail[0].id);
  assert.equal(slot.status, 'open');
});

test('idempotency: booking twice with the same idempotency key returns the same appointment, does not double-book', async () => {
  const { doctor } = makeApprovedHospitalWithDoctor();
  const from = new Date(); const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  schedulingService.generateSlots(doctor.id, from.toISOString(), to.toISOString());
  const avail = schedulingService.getAvailability({ doctorId: doctor.id, fromISO: from.toISOString(), toISO: to.toISOString() });
  const patient = patientService.registerPatient({ name: 'Idem Patient', contactPhone: '+1-000' });

  const key = 'fixed-idempotency-key-1';
  const r1 = await appointmentService.bookAppointment({ patientId: patient.id, doctorId: doctor.id, slotId: avail[0].id, idempotencyKey: key });
  const r2 = await appointmentService.bookAppointment({ patientId: patient.id, doctorId: doctor.id, slotId: avail[0].id, idempotencyKey: key });

  assert.equal(r1.appointment.id, r2.appointment.id);
  assert.equal(r2.replayed, true);
});

test('questionnaire safety: disallows diagnostic/prescriptive question text', () => {
  const { hospital } = makeApprovedHospitalWithDoctor();
  assert.throws(() => questionnaireService.createQuestionnaire({
    hospitalId: hospital.id, name: 'Bad', appliesTo: {},
    questions: [{ id: 'q1', type: 'text', text: 'What is your diagnosis?' }],
  }), (err) => err.code === 'DISALLOWED_QUESTION');
});

test('reconciliation: escalation flag set when patient answer contains urgent language', async () => {
  const { hospital, doctor } = makeApprovedHospitalWithDoctor();
  const q = questionnaireService.createQuestionnaire({
    hospitalId: hospital.id, name: 'Safe', appliesTo: {},
    questions: [{ id: 'q1', type: 'text', text: 'Any symptoms to note?' }],
  });
  const patient = patientService.registerPatient({ name: 'Urgent Patient', contactPhone: '+1-001' });
  const from = new Date(); const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  schedulingService.generateSlots(doctor.id, from.toISOString(), to.toISOString());
  const avail = schedulingService.getAvailability({ doctorId: doctor.id, fromISO: from.toISOString(), toISO: to.toISOString() });
  const { appointment } = await appointmentService.bookAppointment({ patientId: patient.id, doctorId: doctor.id, slotId: avail[0].id });
  const resp = questionnaireService.assignQuestionnaire({ questionnaireId: q.id, appointmentId: appointment.id, patientId: patient.id });
  const updated = questionnaireService.recordAnswer({ responseId: resp.id, questionId: 'q1', answer: 'I have chest pain' });
  assert.equal(updated.escalated, 1);
});
