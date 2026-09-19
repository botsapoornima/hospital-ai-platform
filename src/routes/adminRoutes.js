import { Router } from 'express';
import { requireAuth, requireRole, requireOwnHospital } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { listAudit, listOperationalEvents, traceByCorrelation } from '../core/auditService.js';
import { listCapabilityExecutions } from '../capabilities/registry.js';
import { listWorkflowExecutions } from '../workflows/engine.js';
import * as hospitalService from '../core/hospitalService.js';

export const adminRoutes = Router();

adminRoutes.get('/overview', requireAuth, requireRole('platform_admin'), (req, res) => {
  const counts = (table) => db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
  res.json({
    hospitals: { total: counts('hospitals'), pending: db.prepare(`SELECT COUNT(*) as n FROM hospitals WHERE status IN ('submitted','under_review')`).get().n },
    doctors: counts('doctors'),
    patients: counts('patients'),
    appointments: counts('appointments'),
    appointmentsByStatus: db.prepare(`SELECT status, COUNT(*) as n FROM appointments GROUP BY status`).all(),
    conversations: counts('ai_conversations'),
    reconciliationsOpen: db.prepare(`SELECT COUNT(*) as n FROM reconciliation_records WHERE status = 'open'`).get().n,
    integrationOpsByStatus: db.prepare(`SELECT status, COUNT(*) as n FROM integration_operations GROUP BY status`).all(),
    workflowsByStatus: db.prepare(`SELECT status, COUNT(*) as n FROM workflow_executions GROUP BY status`).all(),
  });
});

adminRoutes.get('/hospital-overview/:hospitalId', requireAuth, requireOwnHospital(req => req.params.hospitalId), (req, res) => {
  const hid = req.params.hospitalId;
  res.json({
    hospital: hospitalService.getHospital(hid),
    doctors: db.prepare(`SELECT COUNT(*) as n FROM doctors WHERE hospital_id = ?`).get(hid).n,
    appointmentsByStatus: db.prepare(`SELECT status, COUNT(*) as n FROM appointments WHERE hospital_id = ? GROUP BY status`).all(hid),
    reconciliationsOpen: db.prepare(`SELECT COUNT(*) as n FROM reconciliation_records WHERE hospital_id = ? AND status = 'open'`).get(hid).n,
  });
});

adminRoutes.get('/audit', requireAuth, (req, res) => {
  const hospitalId = req.actor.role === 'platform_admin' ? req.query.hospitalId : req.actor.hospitalId;
  res.json(listAudit({ hospitalId, limit: Number(req.query.limit) || 100 }));
});

adminRoutes.get('/operational-events', requireAuth, (req, res) => {
  const hospitalId = req.actor.role === 'platform_admin' ? req.query.hospitalId : req.actor.hospitalId;
  res.json(listOperationalEvents({ hospitalId, limit: Number(req.query.limit) || 100 }));
});

adminRoutes.get('/capability-executions', requireAuth, (req, res) => {
  res.json(listCapabilityExecutions({ limit: Number(req.query.limit) || 100 }));
});

adminRoutes.get('/workflow-executions', requireAuth, (req, res) => {
  const hospitalId = req.actor.role === 'platform_admin' ? req.query.hospitalId : req.actor.hospitalId;
  res.json(listWorkflowExecutions({ hospitalId }));
});

adminRoutes.get('/reconciliations', requireAuth, (req, res) => {
  const hospitalId = req.actor.role === 'platform_admin' ? req.query.hospitalId : req.actor.hospitalId;
  const q = hospitalId ? db.prepare(`SELECT * FROM reconciliation_records WHERE hospital_id = ? ORDER BY created_at DESC`).all(hospitalId)
    : db.prepare(`SELECT * FROM reconciliation_records ORDER BY created_at DESC`).all();
  res.json(q);
});

// Full trace of one booking, across every layer (PRD §19).
adminRoutes.get('/trace/:correlationId', requireAuth, (req, res) => {
  res.json(traceByCorrelation(req.params.correlationId));
});
