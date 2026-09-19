import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { recordAudit } from './auditService.js';

export function registerHospital({ name, address, contactEmail, contactPhone, supportedHealthcareSystems = [] }) {
  const id = newId('hosp');
  db.prepare(`
    INSERT INTO hospitals (id, name, address, contact_email, contact_phone, status, supported_healthcare_systems)
    VALUES (?, ?, ?, ?, ?, 'draft', ?)
  `).run(id, name, address, contactEmail, contactPhone, JSON.stringify(supportedHealthcareSystems));
  return getHospital(id);
}

export function submitHospital(hospitalId) {
  return transitionHospital(hospitalId, ['draft'], 'submitted');
}

export function approveHospital(hospitalId, actorId) {
  const hospital = transitionHospital(hospitalId, ['submitted', 'under_review'], 'approved');
  recordAudit({ hospitalId, actorId, actorRole: 'platform_admin', action: 'hospital.approved', entityType: 'hospital', entityId: hospitalId, metadata: {} });
  return hospital;
}

export function rejectHospital(hospitalId, actorId, reason) {
  const hospital = transitionHospital(hospitalId, ['submitted', 'under_review'], 'rejected');
  recordAudit({ hospitalId, actorId, actorRole: 'platform_admin', action: 'hospital.rejected', entityType: 'hospital', entityId: hospitalId, metadata: { reason } });
  return hospital;
}

export function suspendHospital(hospitalId, actorId) {
  const hospital = transitionHospital(hospitalId, ['approved'], 'suspended');
  recordAudit({ hospitalId, actorId, actorRole: 'platform_admin', action: 'hospital.suspended', entityType: 'hospital', entityId: hospitalId, metadata: {} });
  return hospital;
}

export function reactivateHospital(hospitalId, actorId) {
  const hospital = transitionHospital(hospitalId, ['suspended'], 'approved');
  recordAudit({ hospitalId, actorId, actorRole: 'platform_admin', action: 'hospital.reactivated', entityType: 'hospital', entityId: hospitalId, metadata: {} });
  return hospital;
}

function transitionHospital(hospitalId, allowedFrom, to) {
  const hospital = getHospital(hospitalId);
  if (!hospital) throw new AppError('NOT_FOUND', 'Hospital not found');
  if (!allowedFrom.includes(hospital.status)) {
    throw new AppError('INVALID_TRANSITION', `Cannot move hospital from ${hospital.status} to ${to}`);
  }
  db.prepare(`UPDATE hospitals SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(to, hospitalId);
  return getHospital(hospitalId);
}

export function getHospital(id) {
  return db.prepare(`SELECT * FROM hospitals WHERE id = ?`).get(id);
}

export function listHospitals({ status } = {}) {
  if (status) return db.prepare(`SELECT * FROM hospitals WHERE status = ? ORDER BY created_at DESC`).all(status);
  return db.prepare(`SELECT * FROM hospitals ORDER BY created_at DESC`).all();
}

export function isHospitalActive(hospitalId) {
  const h = getHospital(hospitalId);
  return !!h && h.status === 'approved';
}

// Simple typed error used across core services
export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
