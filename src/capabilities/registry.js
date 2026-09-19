import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { AppError } from '../core/hospitalService.js';

const capabilities = new Map();

/**
 * Register a capability. Every AI action in the system must go through one of these -
 * the AI never touches the database or the EHR connector directly (PRD §10).
 *
 * def = {
 *   name, schema: zodSchema, requiresRole: [roles] | null,
 *   handler: async (input, actor) => output
 * }
 */
export function defineCapability(def) {
  capabilities.set(def.name, def);
}

export function listCapabilityNames() {
  return [...capabilities.keys()];
}

export async function executeCapability(name, rawInput, actor, { correlationId, conversationId } = {}) {
  const def = capabilities.get(name);
  const start = Date.now();
  if (!def) {
    logExecution({ conversationId, correlationId, name, input: rawInput, output: null, status: 'failed', error: 'unknown_capability', actorRole: actor?.role, duration: Date.now() - start });
    throw new AppError('UNKNOWN_CAPABILITY', `No such capability: ${name}`);
  }

  // Authorization
  if (def.requiresRole && (!actor || !def.requiresRole.includes(actor.role))) {
    logExecution({ conversationId, correlationId, name, input: rawInput, output: null, status: 'denied', error: 'not_authorized', actorRole: actor?.role, duration: Date.now() - start });
    throw new AppError('NOT_AUTHORIZED', `Role ${actor?.role} is not authorized to execute ${name}`);
  }

  // Validation
  let input;
  try {
    input = def.schema ? def.schema.parse(rawInput) : rawInput;
  } catch (err) {
    logExecution({ conversationId, correlationId, name, input: rawInput, output: null, status: 'failed', error: `validation_error: ${err.message}`, actorRole: actor?.role, duration: Date.now() - start });
    throw new AppError('VALIDATION', `Invalid input for ${name}: ${err.message}`);
  }

  // Tenant isolation guard - if actor is scoped to a hospital, and input references a
  // different hospitalId, deny. Platform admins and patients (cross-tenant by design) are exempt.
  if (actor && actor.hospitalId && input.hospitalId && input.hospitalId !== actor.hospitalId) {
    logExecution({ conversationId, correlationId, name, input, output: null, status: 'denied', error: 'tenant_isolation_violation', actorRole: actor.role, duration: Date.now() - start });
    throw new AppError('TENANT_ISOLATION', 'Cannot act on another hospital\'s data');
  }

  try {
    const output = await def.handler(input, actor);
    logExecution({ conversationId, correlationId, name, input, output, status: 'success', error: null, actorRole: actor?.role, duration: Date.now() - start });
    return output;
  } catch (err) {
    logExecution({ conversationId, correlationId, name, input, output: null, status: 'failed', error: err.message, actorRole: actor?.role, duration: Date.now() - start });
    throw err;
  }
}

function logExecution({ conversationId, correlationId, name, input, output, status, error, actorRole, duration }) {
  db.prepare(`
    INSERT INTO capability_executions (id, conversation_id, correlation_id, capability_name, input, output, status, error, actor_role, duration_ms)
    VALUES (@id, @conversationId, @correlationId, @name, @input, @output, @status, @error, @actorRole, @duration)
  `).run({
    id: newId('capexec'),
    conversationId: conversationId || null,
    correlationId: correlationId || 'no-correlation',
    name,
    input: JSON.stringify(input ?? {}),
    output: output ? JSON.stringify(output) : null,
    status, error, actorRole: actorRole || null, duration,
  });
}

export function listCapabilityExecutions({ conversationId, correlationId, limit = 100 } = {}) {
  if (conversationId) return db.prepare(`SELECT * FROM capability_executions WHERE conversation_id = ? ORDER BY created_at ASC`).all(conversationId);
  if (correlationId) return db.prepare(`SELECT * FROM capability_executions WHERE correlation_id = ? ORDER BY created_at ASC`).all(correlationId);
  return db.prepare(`SELECT * FROM capability_executions ORDER BY created_at DESC LIMIT ?`).all(limit);
}
