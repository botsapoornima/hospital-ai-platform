import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';

// Privacy-aware: metadata should be structured references (ids, statuses, counts),
// never raw clinical free-text (e.g. questionnaire answers, symptom descriptions).
const CLINICAL_KEYS = new Set(['responses', 'symptom', 'symptoms', 'notes', 'freeText', 'answer']);

function sanitize(metadata = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (CLINICAL_KEYS.has(k)) {
      clean[k] = '[redacted:clinical-content]';
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export function recordAudit({ correlationId, hospitalId, actorId, actorRole, action, entityType, entityId, metadata }) {
  db.prepare(`
    INSERT INTO audit_events (id, correlation_id, hospital_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
    VALUES (@id, @correlationId, @hospitalId, @actorId, @actorRole, @action, @entityType, @entityId, @metadata)
  `).run({
    id: newId('audit'),
    correlationId: correlationId || null,
    hospitalId: hospitalId || null,
    actorId: actorId || null,
    actorRole: actorRole || null,
    action,
    entityType: entityType || null,
    entityId: entityId || null,
    metadata: JSON.stringify(sanitize(metadata)),
  });
}

export function recordOperationalEvent({ correlationId, hospitalId, eventType, severity = 'info', metadata }) {
  db.prepare(`
    INSERT INTO operational_events (id, correlation_id, hospital_id, event_type, severity, metadata)
    VALUES (@id, @correlationId, @hospitalId, @eventType, @severity, @metadata)
  `).run({
    id: newId('opev'),
    correlationId: correlationId || null,
    hospitalId: hospitalId || null,
    eventType,
    severity,
    metadata: JSON.stringify(sanitize(metadata || {})),
  });
}

export function listAudit({ hospitalId, limit = 100 } = {}) {
  if (hospitalId) {
    return db.prepare(`SELECT * FROM audit_events WHERE hospital_id = ? ORDER BY created_at DESC LIMIT ?`).all(hospitalId, limit);
  }
  return db.prepare(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function listOperationalEvents({ hospitalId, limit = 100 } = {}) {
  if (hospitalId) {
    return db.prepare(`SELECT * FROM operational_events WHERE hospital_id = ? ORDER BY created_at DESC LIMIT ?`).all(hospitalId, limit);
  }
  return db.prepare(`SELECT * FROM operational_events ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function traceByCorrelation(correlationId) {
  return {
    audit: db.prepare(`SELECT * FROM audit_events WHERE correlation_id = ? ORDER BY created_at ASC`).all(correlationId),
    capabilities: db.prepare(`SELECT * FROM capability_executions WHERE correlation_id = ? ORDER BY created_at ASC`).all(correlationId),
    integrationOps: db.prepare(`SELECT * FROM integration_operations WHERE correlation_id = ? ORDER BY created_at ASC`).all(correlationId),
    workflowExecutions: db.prepare(`SELECT * FROM workflow_executions WHERE correlation_id = ? ORDER BY created_at ASC`).all(correlationId),
    operationalEvents: db.prepare(`SELECT * FROM operational_events WHERE correlation_id = ? ORDER BY created_at ASC`).all(correlationId),
  };
}
