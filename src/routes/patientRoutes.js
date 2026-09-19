import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as patientService from '../core/patientService.js';
import * as appointmentService from '../core/appointmentService.js';
import * as questionnaireService from '../core/questionnaireService.js';
import * as doctorService from '../core/doctorService.js';

export const patientRoutes = Router();

patientRoutes.post('/register', (req, res) => {
  res.status(201).json(patientService.registerPatient(req.body));
});

patientRoutes.get('/:id', requireAuth, (req, res) => {
  res.json(patientService.getPatient(req.params.id));
});

patientRoutes.get('/:id/appointments', requireAuth, (req, res) => {
  res.json(patientService.listAppointmentsForPatient(req.params.id));
});

patientRoutes.get('/:id/preferences', requireAuth, (req, res) => {
  res.json(patientService.getPreferences(req.params.id));
});

patientRoutes.put('/:id/preferences', requireAuth, (req, res) => {
  res.json(patientService.updatePreferences(req.params.id, req.body));
});

patientRoutes.get('/appointments/:appointmentId/questionnaires', requireAuth, (req, res) => {
  res.json(questionnaireService.listResponsesForAppointment(req.params.appointmentId));
});

patientRoutes.post('/questionnaire-responses/:responseId/answers', requireAuth, (req, res) => {
  res.json(questionnaireService.recordAnswer({ responseId: req.params.responseId, ...req.body }));
});

patientRoutes.post('/questionnaire-responses/:responseId/complete', requireAuth, (req, res) => {
  res.json(questionnaireService.completeQuestionnaire(req.params.responseId));
});

// ---- Doctor self-service ----
export const doctorSelfRoutes = Router();

doctorSelfRoutes.get('/:id/appointments', requireAuth, requireRole('doctor', 'hospital_admin', 'platform_admin'), (req, res) => {
  res.json(appointmentService.listAppointmentsForDoctor(req.params.id));
});

doctorSelfRoutes.get('/:id', requireAuth, (req, res) => {
  res.json(doctorService.getDoctor(req.params.id));
});

doctorSelfRoutes.get('/:id/calendar', requireAuth, (req, res) => {
  res.json(doctorService.getCalendarForDoctor(req.params.id));
});
