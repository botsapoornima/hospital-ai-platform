import { z } from 'zod';
import { defineCapability } from './registry.js';
import * as hospitalService from '../core/hospitalService.js';
import * as doctorService from '../core/doctorService.js';
import * as patientService from '../core/patientService.js';
import * as scheduling from '../core/schedulingService.js';
import * as appointmentService from '../core/appointmentService.js';
import * as questionnaireService from '../core/questionnaireService.js';
import * as notificationService from '../core/notificationService.js';
import { emitEvent } from '../workflows/engine.js';
import { db } from '../db/index.js';
import { newId, newCorrelationId } from '../utils/ids.js';

// ---- Discovery ----
defineCapability({
  name: 'search_hospitals',
  schema: z.object({ query: z.string().optional(), specialty: z.string().optional() }),
  requiresRole: null, // patients (unauthenticated in-conversation) can discover
  handler: async ({ query, specialty }) => {
    const hospitals = hospitalService.listHospitals({ status: 'approved' });
    let filtered = hospitals;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(h => h.name.toLowerCase().includes(q));
    }
    if (specialty) {
      const withSpecialty = new Set();
      for (const h of filtered) {
        const specs = doctorService.listSpecialties(h.id);
        if (specs.some(s => s.name.toLowerCase().includes(specialty.toLowerCase()))) withSpecialty.add(h.id);
      }
      filtered = filtered.filter(h => withSpecialty.has(h.id));
    }
    return filtered.map(h => ({ id: h.id, name: h.name, address: h.address }));
  },
});

defineCapability({
  name: 'search_doctors',
  schema: z.object({ hospitalId: z.string().optional(), specialty: z.string().optional(), query: z.string().optional() }),
  requiresRole: null,
  handler: async ({ hospitalId, specialty, query }) => {
    let doctors = doctorService.listDoctors({ hospitalId, status: 'active' });
    if (specialty) {
      doctors = doctors.filter(d => {
        if (!d.specialty_id) return false;
        const spec = db.prepare(`SELECT name FROM specialties WHERE id = ?`).get(d.specialty_id);
        return spec && spec.name.toLowerCase().includes(specialty.toLowerCase());
      });
    }
    if (query) doctors = doctors.filter(d => d.name.toLowerCase().includes(query.toLowerCase()));
    return doctors.map(d => ({ id: d.id, name: d.name, hospitalId: d.hospital_id, specialtyId: d.specialty_id, durationMinutes: d.appointment_duration_minutes }));
  },
});

defineCapability({
  name: 'check_availability',
  schema: z.object({
    doctorId: z.string().optional(),
    hospitalId: z.string().optional(),
    specialtyId: z.string().optional(),
    fromISO: z.string(),
    toISO: z.string(),
    appointmentType: z.string().optional(),
  }),
  requiresRole: null,
  handler: async (input) => {
    const slots = scheduling.getAvailability(input);
    return slots.map(s => ({ slotId: s.id, doctorId: s.doctor_id, doctorName: s.doctor_name, startAt: s.start_at, endAt: s.end_at }));
  },
});

// ---- Patient ----
defineCapability({
  name: 'lookup_patient',
  schema: z.object({ contactPhone: z.string().optional(), contactEmail: z.string().optional() }),
  requiresRole: null,
  handler: async (input) => patientService.findPatientByContact(input) || null,
});

defineCapability({
  name: 'get_context',
  schema: z.object({ patientId: z.string() }),
  requiresRole: null,
  handler: async ({ patientId }) => ({
    preferences: patientService.getPreferences(patientId),
    upcomingAppointments: patientService.listAppointmentsForPatient(patientId).filter(a => ['pending', 'confirmed', 'rescheduled'].includes(a.status)),
  }),
});

defineCapability({
  name: 'update_preferences',
  schema: z.object({ patientId: z.string(), preferences: z.record(z.any()) }),
  requiresRole: null,
  handler: async ({ patientId, preferences }) => patientService.updatePreferences(patientId, preferences),
});

// ---- Appointments ----
defineCapability({
  name: 'get_appointment',
  schema: z.object({ appointmentId: z.string() }),
  requiresRole: null,
  handler: async ({ appointmentId }) => appointmentService.getAppointment(appointmentId),
});

defineCapability({
  name: 'create_appointment',
  schema: z.object({
    patientId: z.string(), doctorId: z.string(), slotId: z.string(),
    appointmentType: z.string().optional(), idempotencyKey: z.string().optional(), correlationId: z.string().optional(),
  }),
  requiresRole: null,
  handler: async (input) => appointmentService.bookAppointment(input),
});

defineCapability({
  name: 'reschedule_appointment',
  schema: z.object({ appointmentId: z.string(), newSlotId: z.string(), correlationId: z.string().optional() }),
  requiresRole: null,
  handler: async (input) => appointmentService.rescheduleAppointment(input),
});

defineCapability({
  name: 'cancel_appointment',
  schema: z.object({ appointmentId: z.string(), reason: z.string().optional(), correlationId: z.string().optional() }),
  requiresRole: null,
  handler: async (input) => appointmentService.cancelAppointment(input),
});

// ---- Questionnaire ----
defineCapability({
  name: 'get_questionnaire',
  schema: z.object({ responseId: z.string() }),
  requiresRole: null,
  handler: async ({ responseId }) => {
    const resp = questionnaireService.getResponse(responseId);
    if (!resp) return null;
    const questionnaire = questionnaireService.getQuestionnaire(resp.questionnaire_id);
    return { response: resp, questions: JSON.parse(questionnaire.questions) };
  },
});

defineCapability({
  name: 'submit_questionnaire',
  schema: z.object({ responseId: z.string(), questionId: z.string(), answer: z.any(), correlationId: z.string().optional() }),
  requiresRole: null,
  handler: async (input) => questionnaireService.recordAnswer(input),
});

// ---- Notification / Workflow ----
defineCapability({
  name: 'send_notification',
  schema: z.object({ hospitalId: z.string().optional(), recipientType: z.enum(['patient', 'doctor', 'hospital']), recipientId: z.string(), category: z.string(), content: z.string(), correlationId: z.string().optional() }),
  requiresRole: ['platform_admin', 'hospital_admin', 'doctor'],
  handler: async (input) => notificationService.sendNotification(input),
});

defineCapability({
  name: 'start_workflow',
  schema: z.object({ eventType: z.string(), context: z.record(z.any()) }),
  requiresRole: ['platform_admin', 'hospital_admin'],
  handler: async ({ eventType, context }) => {
    emitEvent(eventType, { ...context, correlationId: context.correlationId || newCorrelationId() });
    return { started: true };
  },
});

// ---- Integration verification / sync (exposed for admin/ops tooling and AI status checks) ----
defineCapability({
  name: 'verify_external_appointment',
  schema: z.object({ appointmentId: z.string() }),
  requiresRole: null,
  handler: async ({ appointmentId }) => {
    const appt = appointmentService.getAppointment(appointmentId);
    if (!appt) return null;
    const verifications = db.prepare(`SELECT * FROM integration_verifications WHERE appointment_id = ? ORDER BY created_at DESC LIMIT 1`).get(appointmentId);
    return { appointmentStatus: appt.status, externalAppointmentId: appt.external_appointment_id, lastVerification: verifications || null };
  },
});

defineCapability({
  name: 'synchronize_state',
  schema: z.object({ appointmentId: z.string() }),
  requiresRole: ['platform_admin', 'hospital_admin'],
  handler: async ({ appointmentId }) => {
    // Manual re-sync trigger for ops dashboards - re-runs verification against the mock EHR.
    const appt = appointmentService.getAppointment(appointmentId);
    if (!appt) throw new Error('Appointment not found');
    return { appointmentId, status: appt.status, externalAppointmentId: appt.external_appointment_id };
  },
});

// ---- Human escalation ----
defineCapability({
  name: 'transfer_to_human',
  schema: z.object({ conversationId: z.string().optional(), reason: z.string() }),
  requiresRole: null,
  handler: async ({ conversationId, reason }) => {
    if (conversationId) {
      db.prepare(`UPDATE ai_conversations SET status = 'escalated' WHERE id = ?`).run(conversationId);
    }
    return { escalated: true, reason };
  },
});
