import { db, resetDb } from './index.js';
import { migrate } from './schema.js';
import { newId } from '../utils/ids.js';
import { hashPassword } from '../utils/password.js';
import * as hospitalService from '../core/hospitalService.js';
import * as doctorService from '../core/doctorService.js';
import * as schedulingService from '../core/schedulingService.js';
import * as questionnaireService from '../core/questionnaireService.js';
import * as patientService from '../core/patientService.js';

resetDb();
migrate(db);

function createUserRow({ role, hospitalId, doctorId, patientId, email, password, name }) {
  const id = newId('user');
  db.prepare(`INSERT INTO users (id, role, hospital_id, doctor_id, patient_id, email, password_hash, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, role, hospitalId || null, doctorId || null, patientId || null, email, hashPassword(password), name);
  return id;
}

// ---- Platform admin ----
createUserRow({ role: 'platform_admin', email: 'admin@platform.dev', password: 'admin123', name: 'Platform Admin' });

// ---- Hospital 1: fully configured, approved ----
const h1 = hospitalService.registerHospital({
  name: 'Riverside General Hospital', address: '100 Riverside Dr', contactEmail: 'ops@riverside.example',
  contactPhone: '+1-555-0100', supportedHealthcareSystems: ['mock_ehr'],
});
hospitalService.submitHospital(h1.id);
hospitalService.approveHospital(h1.id, 'system-seed');

db.prepare(`INSERT INTO healthcare_system_connections (id, hospital_id, connector_type, config, status) VALUES (?, ?, 'mock_ehr', '{}', 'active')`)
  .run(newId('hsc'), h1.id);

createUserRow({ role: 'hospital_admin', hospitalId: h1.id, email: 'admin@riverside.example', password: 'admin123', name: 'Riverside Admin' });

const orthoSpec = doctorService.createSpecialty(h1.id, 'Orthopedics');
const genSpec = doctorService.createSpecialty(h1.id, 'General Medicine');
const cardioSpec = doctorService.createSpecialty(h1.id, 'Cardiology');
const dept = doctorService.createDepartment(h1.id, 'Outpatient Care');

const drRao = doctorService.createDoctor({
  hospitalId: h1.id, name: 'Dr. Anjali Rao', specialtyId: orthoSpec.id, departmentId: dept.id,
  qualifications: 'MD Orthopedics', languages: ['en', 'hi'], consultationTypes: ['in_person', 'video'],
  appointmentDurationMinutes: 30, externalProviderId: null,
});
doctorService.activateDoctor(drRao.id);

const drLee = doctorService.createDoctor({
  hospitalId: h1.id, name: 'Dr. Sam Lee', specialtyId: genSpec.id, departmentId: dept.id,
  qualifications: 'MD Internal Medicine', languages: ['en'], consultationTypes: ['in_person'],
  appointmentDurationMinutes: 20,
});
doctorService.activateDoctor(drLee.id);

const drPatel = doctorService.createDoctor({
  hospitalId: h1.id, name: 'Dr. Nina Patel', specialtyId: cardioSpec.id, departmentId: dept.id,
  qualifications: 'MD Cardiology', languages: ['en'], consultationTypes: ['in_person'],
  appointmentDurationMinutes: 30,
});
doctorService.activateDoctor(drPatel.id);

createUserRow({ role: 'doctor', hospitalId: h1.id, doctorId: drRao.id, email: 'rao@riverside.example', password: 'doctor123', name: 'Dr. Anjali Rao' });

// Working hours: Mon-Fri 9am-5pm for all three doctors
for (const doc of [drRao, drLee, drPatel]) {
  const cal = doctorService.getCalendarForDoctor(doc.id);
  doctorService.setWorkingHours(cal.id, [1, 2, 3, 4, 5].map(dow => ({ dayOfWeek: dow, startTime: '09:00', endTime: '17:00' })));
}

// Generate slots for the next 14 days for all three doctors
const now = new Date();
const in14 = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
for (const doc of [drRao, drLee, drPatel]) {
  schedulingService.generateSlots(doc.id, now.toISOString(), in14.toISOString());
}

// Pre-visit questionnaire for orthopedics
questionnaireService.createQuestionnaire({
  hospitalId: h1.id,
  name: 'Orthopedics Pre-Visit',
  appliesTo: { specialtyId: orthoSpec.id },
  questions: [
    { id: 'q1', type: 'text', text: 'When did your pain or discomfort start?' },
    { id: 'q2', type: 'choice', text: 'How would you rate the pain?', options: ['Mild', 'Moderate', 'Severe'] },
    { id: 'q3', type: 'yes_no', text: 'Have you had any recent injury or fall?' },
  ],
});

// Default platform-level workflow: on booking confirmed, assign questionnaire, notify patient/doctor, then remind.
db.prepare(`
  INSERT INTO workflows (id, hospital_id, name, trigger_event, steps, is_active)
  VALUES (?, NULL, 'Post-Booking Follow-up', 'appointment.confirmed', ?, 1)
`).run(newId('wf'), JSON.stringify([
  { type: 'send_notification', recipientType: 'patient', category: 'confirmation' },
  { type: 'send_notification', recipientType: 'doctor', category: 'confirmation' },
  { type: 'assign_questionnaire' },
  { type: 'wait', delaySeconds: 5 },
  { type: 'send_notification', recipientType: 'patient', category: 'questionnaire_reminder' },
]));

db.prepare(`
  INSERT INTO workflows (id, hospital_id, name, trigger_event, steps, is_active)
  VALUES (?, NULL, 'Cancellation Notice', 'appointment.cancelled', ?, 1)
`).run(newId('wf'), JSON.stringify([
  { type: 'send_notification', recipientType: 'patient', category: 'cancellation' },
  { type: 'send_notification', recipientType: 'doctor', category: 'cancellation' },
]));

db.prepare(`
  INSERT INTO workflows (id, hospital_id, name, trigger_event, steps, is_active)
  VALUES (?, NULL, 'Reschedule Notice', 'appointment.rescheduled', ?, 1)
`).run(newId('wf'), JSON.stringify([
  { type: 'send_notification', recipientType: 'patient', category: 'rescheduled' },
  { type: 'send_notification', recipientType: 'doctor', category: 'rescheduled' },
]));

// ---- Hospital 2: a second approved tenant, to demonstrate tenant isolation ----
const h2 = hospitalService.registerHospital({
  name: 'Lakeside Community Clinic', address: '200 Lakeside Ave', contactEmail: 'ops@lakeside.example',
  contactPhone: '+1-555-0200', supportedHealthcareSystems: ['mock_ehr'],
});
hospitalService.submitHospital(h2.id);
hospitalService.approveHospital(h2.id, 'system-seed');
createUserRow({ role: 'hospital_admin', hospitalId: h2.id, email: 'admin@lakeside.example', password: 'admin123', name: 'Lakeside Admin' });
const h2spec = doctorService.createSpecialty(h2.id, 'Dermatology');
const drKim = doctorService.createDoctor({ hospitalId: h2.id, name: 'Dr. Jin Kim', specialtyId: h2spec.id, appointmentDurationMinutes: 25 });
doctorService.activateDoctor(drKim.id);
const cal2 = doctorService.getCalendarForDoctor(drKim.id);
doctorService.setWorkingHours(cal2.id, [1, 2, 3, 4, 5].map(dow => ({ dayOfWeek: dow, startTime: '10:00', endTime: '15:00' })));
schedulingService.generateSlots(drKim.id, now.toISOString(), in14.toISOString());

// ---- A hospital still in draft, to demonstrate onboarding lifecycle ----
hospitalService.registerHospital({ name: 'Summit Health Partners (Draft)', address: '5 Summit Way', contactEmail: 'ops@summit.example', contactPhone: '+1-555-0300' });

// ---- A demo patient ----
const patient = patientService.registerPatient({ name: 'Jordan Smith', contactPhone: '+1-555-9999', contactEmail: 'jordan@example.com', dateOfBirth: '1990-04-12' });
createUserRow({ role: 'patient', patientId: patient.id, email: 'jordan@example.com', password: 'patient123', name: 'Jordan Smith' });

console.log('Seed complete.');
console.log('--- Demo accounts ---');
console.log('Platform admin: admin@platform.dev / admin123');
console.log('Riverside hospital admin: admin@riverside.example / admin123');
console.log('Riverside doctor (Dr. Rao):  rao@riverside.example / doctor123');
console.log('Lakeside hospital admin: admin@lakeside.example / admin123');
console.log('Patient (Jordan Smith, phone +1-555-9999): jordan@example.com / patient123');
console.log('Hospital IDs:', { riverside: h1.id, lakeside: h2.id });
console.log('Doctor IDs:', { rao: drRao.id, lee: drLee.id, patel: drPatel.id, kim: drKim.id });
console.log('Patient ID:', patient.id);
