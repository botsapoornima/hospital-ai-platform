import { db } from '../db/index.js';
import { newId, newCorrelationId } from '../utils/ids.js';
import { sendNotification } from '../core/notificationService.js';
import { findApplicableQuestionnaire, assignQuestionnaire } from '../core/questionnaireService.js';
import { recordOperationalEvent, recordAudit } from '../core/auditService.js';

// emitEvent is intentionally decoupled from HTTP request/response - any core service
// can raise a platform event and the workflow engine reacts asynchronously.
export function emitEvent(eventType, context) {
  recordOperationalEvent({
    correlationId: context.correlationId,
    hospitalId: context.hospitalId,
    eventType,
    severity: 'info',
    metadata: { appointmentId: context.appointmentId },
  });

  const workflows = db.prepare(`
    SELECT * FROM workflows WHERE trigger_event = ? AND is_active = 1 AND (hospital_id IS NULL OR hospital_id = ?)
  `).all(eventType, context.hospitalId || null);

  for (const wf of workflows) {
    const execId = newId('wfexec');
    db.prepare(`
      INSERT INTO workflow_executions (id, workflow_id, correlation_id, context, current_step, status, run_after)
      VALUES (?, ?, ?, ?, 0, 'running', NULL)
    `).run(execId, wf.id, context.correlationId || newCorrelationId(), JSON.stringify(context));
    runExecution(execId);
  }
}

function getExecution(id) {
  return db.prepare(`SELECT * FROM workflow_executions WHERE id = ?`).get(id);
}

function executeStep(step, context, execId) {
  switch (step.type) {
    case 'assign_questionnaire': {
      const appt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(context.appointmentId);
      if (!appt) return;
      const doctor = db.prepare(`SELECT * FROM doctors WHERE id = ?`).get(appt.doctor_id);
      const q = findApplicableQuestionnaire({ hospitalId: appt.hospital_id, doctorId: appt.doctor_id, specialtyId: doctor?.specialty_id, appointmentType: appt.appointment_type });
      if (q) {
        const resp = assignQuestionnaire({ questionnaireId: q.id, appointmentId: appt.id, patientId: appt.patient_id });
        recordOperationalEvent({ correlationId: context.correlationId, hospitalId: appt.hospital_id, eventType: 'questionnaire.assigned', metadata: { appointmentId: appt.id, responseId: resp.id } });
      }
      break;
    }
    case 'send_notification': {
      const appt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(context.appointmentId);
      const recipientId = step.recipientType === 'doctor' ? context.doctorId : context.patientId;
      sendNotification({
        hospitalId: context.hospitalId,
        recipientType: step.recipientType || 'patient',
        recipientId,
        category: step.category,
        content: renderTemplate(step.category, appt),
        correlationId: context.correlationId,
      });
      break;
    }
    default:
      break;
  }
}

function renderTemplate(category, appt) {
  const templates = {
    confirmation: `Your appointment is confirmed for ${appt?.start_at}.`,
    reminder: `Reminder: you have an appointment on ${appt?.start_at}.`,
    cancellation: `Your appointment has been cancelled.`,
    rescheduled: `Your appointment has been rescheduled to ${appt?.start_at}.`,
    questionnaire_reminder: `Please complete your pre-visit questionnaire before your appointment.`,
  };
  return templates[category] || `Update regarding your appointment.`;
}

function runExecution(execId) {
  const exec = getExecution(execId);
  if (!exec || exec.status !== 'running') return;
  const wf = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(exec.workflow_id);
  const steps = JSON.parse(wf.steps);
  const context = JSON.parse(exec.context);

  let stepIndex = exec.current_step;
  while (stepIndex < steps.length) {
    const step = steps[stepIndex];
    if (step.type === 'wait') {
      // Compute run_after in SQLite's own datetime('now') format so the later
      // string comparison in tickWorkflows() is apples-to-apples (a JS ISO string
      // with 'T'/'Z' does not sort correctly against SQLite's 'YYYY-MM-DD HH:MM:SS').
      db.prepare(`
        UPDATE workflow_executions
        SET current_step = ?, status = 'waiting',
            run_after = datetime('now', '+' || ? || ' seconds'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(stepIndex + 1, step.delaySeconds || 0, execId);
      return; // resume later via the poller
    }
    try {
      executeStep(step, context, execId);
    } catch (err) {
      db.prepare(`UPDATE workflow_executions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(execId);
      recordOperationalEvent({ correlationId: context.correlationId, hospitalId: context.hospitalId, eventType: 'workflow.failed', severity: 'error', metadata: { workflowId: wf.id, step: stepIndex, error: err.message } });
      return;
    }
    stepIndex += 1;
  }
  db.prepare(`UPDATE workflow_executions SET current_step = ?, status = 'completed', updated_at = datetime('now') WHERE id = ?`).run(stepIndex, execId);
}

// Poller: resumes any workflow executions whose delay has elapsed. Called on an interval
// from server.js, and can also be invoked synchronously by tests to avoid real waiting.
export function tickWorkflows() {
  const due = db.prepare(`SELECT * FROM workflow_executions WHERE status = 'waiting' AND run_after <= datetime('now')`).all();
  for (const exec of due) {
    db.prepare(`UPDATE workflow_executions SET status = 'running' WHERE id = ?`).run(exec.id);
    runExecution(exec.id);
  }
  return due.length;
}

export function listWorkflowExecutions({ hospitalId, limit = 100 } = {}) {
  // context is JSON text; filter in JS for simplicity at prototype scale
  const rows = db.prepare(`SELECT * FROM workflow_executions ORDER BY created_at DESC LIMIT ?`).all(limit);
  if (!hospitalId) return rows;
  return rows.filter(r => JSON.parse(r.context).hospitalId === hospitalId);
}
