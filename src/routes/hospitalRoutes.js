import { Router } from 'express';
import { requireAuth, requireRole, requireOwnHospital } from '../middleware/auth.js';
import * as hospitalService from '../core/hospitalService.js';
import * as doctorService from '../core/doctorService.js';
import * as schedulingService from '../core/schedulingService.js';
import * as questionnaireService from '../core/questionnaireService.js';
import * as appointmentService from '../core/appointmentService.js';
import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { hashPassword } from '../utils/password.js';

export const hospitalRoutes = Router();

// ---- Public: self-service registration ----
hospitalRoutes.post('/register', (req, res) => {
  try {
    const hospital = hospitalService.registerHospital(req.body);
    res.status(201).json(hospital);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.post('/:id/submit', (req, res) => {
  try { res.json(hospitalService.submitHospital(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Platform admin: review lifecycle ----
hospitalRoutes.get('/', requireAuth, (req, res) => {
  res.json(hospitalService.listHospitals(req.query));
});

hospitalRoutes.post('/:id/approve', requireAuth, requireRole('platform_admin'), (req, res) => {
  try { res.json(hospitalService.approveHospital(req.params.id, req.actor.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.post('/:id/reject', requireAuth, requireRole('platform_admin'), (req, res) => {
  try { res.json(hospitalService.rejectHospital(req.params.id, req.actor.id, req.body.reason)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.post('/:id/suspend', requireAuth, requireRole('platform_admin'), (req, res) => {
  try { res.json(hospitalService.suspendHospital(req.params.id, req.actor.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.post('/:id/reactivate', requireAuth, requireRole('platform_admin'), (req, res) => {
  try { res.json(hospitalService.reactivateHospital(req.params.id, req.actor.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ---- Hospital admin: configuration (tenant-scoped) ----
hospitalRoutes.get('/:id', requireAuth, requireOwnHospital(req => req.params.id), (req, res) => {
  res.json(hospitalService.getHospital(req.params.id));
});

hospitalRoutes.post('/:id/departments', requireAuth, requireRole('hospital_admin', 'platform_admin'), requireOwnHospital(req => req.params.id), (req, res) => {
  res.status(201).json(doctorService.createDepartment(req.params.id, req.body.name));
});

hospitalRoutes.post('/:id/specialties', requireAuth, requireRole('hospital_admin', 'platform_admin'), requireOwnHospital(req => req.params.id), (req, res) => {
  res.status(201).json(doctorService.createSpecialty(req.params.id, req.body.name));
});

hospitalRoutes.get('/:id/specialties', requireAuth, requireOwnHospital(req => req.params.id), (req, res) => {
  res.json(doctorService.listSpecialties(req.params.id));
});

hospitalRoutes.post('/:id/doctors', requireAuth, requireRole('hospital_admin', 'platform_admin'), requireOwnHospital(req => req.params.id), (req, res) => {
  try {
    const doctor = doctorService.createDoctor({ hospitalId: req.params.id, ...req.body });
    res.status(201).json(doctor);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.get('/:id/doctors', requireAuth, requireOwnHospital(req => req.params.id), (req, res) => {
  res.json(doctorService.listDoctors({ hospitalId: req.params.id }));
});

hospitalRoutes.post('/doctors/:doctorId/activate', requireAuth, requireRole('hospital_admin', 'platform_admin'), (req, res) => {
  res.json(doctorService.activateDoctor(req.params.doctorId));
});

hospitalRoutes.post('/doctors/:doctorId/working-hours', requireAuth, requireRole('hospital_admin', 'platform_admin', 'doctor'), (req, res) => {
  const calendar = doctorService.getCalendarForDoctor(req.params.doctorId);
  res.json(doctorService.setWorkingHours(calendar.id, req.body.hours));
});

hospitalRoutes.post('/doctors/:doctorId/blocked-slots', requireAuth, requireRole('hospital_admin', 'platform_admin', 'doctor'), (req, res) => {
  const calendar = doctorService.getCalendarForDoctor(req.params.doctorId);
  res.status(201).json(doctorService.addBlockedSlot(calendar.id, req.body));
});

hospitalRoutes.post('/doctors/:doctorId/generate-slots', requireAuth, requireRole('hospital_admin', 'platform_admin', 'doctor'), (req, res) => {
  try {
    const count = schedulingService.generateSlots(req.params.doctorId, req.body.fromISO, req.body.toISO, req.body.appointmentType);
    res.json({ slotsCreated: count });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.post('/:id/questionnaires', requireAuth, requireRole('hospital_admin', 'platform_admin'), requireOwnHospital(req => req.params.id), (req, res) => {
  try {
    res.status(201).json(questionnaireService.createQuestionnaire({ hospitalId: req.params.id, ...req.body }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

hospitalRoutes.get('/:id/questionnaires', requireAuth, requireOwnHospital(req => req.params.id), (req, res) => {
  res.json(questionnaireService.listQuestionnaires(req.params.id));
});

hospitalRoutes.get('/:id/appointments', requireAuth, requireOwnHospital(req => req.params.id), (req, res) => {
  res.json(appointmentService.listAppointmentsForHospital(req.params.id, req.query));
});

// Create hospital admin/staff account (platform admin bootstraps, or hospital admin adds staff)
hospitalRoutes.post('/:id/staff', requireAuth, requireRole('hospital_admin', 'platform_admin'), requireOwnHospital(req => req.params.id), (req, res) => {
  const id = newId('user');
  db.prepare(`INSERT INTO users (id, role, hospital_id, email, password_hash, name) VALUES (?, 'hospital_admin', ?, ?, ?, ?)`)
    .run(id, req.params.id, req.body.email, hashPassword(req.body.password), req.body.name);
  res.status(201).json({ id, email: req.body.email, role: 'hospital_admin' });
});
