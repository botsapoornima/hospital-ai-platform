# Architecture

## High-level layering

The implementation follows the layering required by the spec (§24) exactly:

```
Interfaces (routes/, public/)
        │
Application / AI (ai/agent.js)
        │
Context + Capabilities (ai/contextManager.js, capabilities/)
        │
Core Services (core/*.js)
        │
Scheduling (core/schedulingService.js)
        │
Integration / Connectors (integration/*.js)
        │
External Systems (mock EHR, in mockEhrConnector.js)
        │
Verification / Synchronization (integration/integrationLayer.js)
        │
Events / Workflows (workflows/engine.js)
        │
Data / Analytics / Observability (db/schema.js, core/auditService.js)
```

Enforced boundaries:

- **The AI agent never imports a core service or the EHR connector directly.** Every
  action it takes goes through `capabilities/registry.js#executeCapability`, which
  validates input against a zod schema, checks role authorization, enforces tenant
  isolation, executes the handler, and logs the result to `capability_executions`
  — success, failure, or denial — regardless of outcome.
- **Scheduling doesn't know about conversations.** `schedulingService.js` has no
  imports from `ai/` or `routes/`. It's a pure slot-management module.
- **Only `mockEhrConnector.js` is vendor-specific.** `integrationLayer.js` calls its
  five functions (`lookupPatient`, `lookupProvider`, `createAppointment`,
  `updateAppointment`, `cancelAppointment`, `getAppointment`,
  `findAppointmentByIdempotencyKey`) and nothing else. A real EHR connector (Epic,
  Cerner, a FHIR gateway) implementing the same function signatures drops in without
  touching `integrationLayer.js`, `appointmentService.js`, the capability layer, or
  the AI agent.
- **Workflows are event-driven and async.** Core services never call
  `notificationService` or `questionnaireService` directly on a booking — they call
  `emitEvent('appointment.confirmed', ...)` and the workflow engine (`workflows/engine.js`)
  looks up matching `workflows` rows and runs their steps, including delayed ones.

## Data model (§22)

All entities live in `src/db/schema.js` as one SQL file (SQLite dialect, portable to
Postgres with minor syntax changes — types, `datetime('now')` → `now()`, etc). Key
relationships:

- `hospitals` 1—N `departments`, `specialties`, `doctors`
- `doctors` 1—1 `calendars` 1—N `working_hours`, `blocked_slots`, and materialized `slots`
- `slots` are the **only** thing `schedulingService.getAvailability()` reads — nothing
  invents availability; slots are pre-materialized from working hours by
  `generateSlots()` and only ever removed from consideration by status transition,
  never queried "live" against working hours at booking time (avoids drift)
- `appointments` references `slots`, has its own `idempotency_key` (unique) and
  `correlation_id`, and an `appointment_history` table for full state-transition audit
- `external_identifier_mappings` is the single source of truth for
  internal↔external ID pairs, keyed by `(hospital_id, entity_type, internal_id)` —
  this is how tenant isolation extends into the integration layer (hospital A's
  mapping table entries are never visible to hospital B's queries)
- `integration_operations` / `integration_verifications` / `reconciliation_records`
  form the audit trail for every EHR call, its outcome classification, and any
  unresolved cases
- `ai_conversations` / `ai_messages` / `ai_context` are kept **separate** from
  `capability_executions`, which are separate again from `audit_events` — per §23,
  conversational state, capability-execution state, and durable audit state are not
  merged into one blob

See the `State Management` section below for why this separation matters.

## Booking sequence (the critical path)

```
1. Patient message → ai/agent.js#handleMessage
2. Intent + entity extraction (ai/nlu.js) → specialty inferred, timeframe parsed
3. Capability calls: search_doctors → check_availability (real slots only)
4. Patient picks an option, confirms
5. Capability call: create_appointment
     → appointmentService.bookAppointment()
         → schedulingService.revalidateSlot()   [re-check eligibility right before booking]
         → schedulingService.reserveSlot()       [atomic: UPDATE ... WHERE status='open']
         → INSERT appointments (status='pending', idempotency_key, correlation_id)
         → integrationLayer.createAppointmentWithVerification()
             → ensureMappings()                  [patient/provider external IDs]
             → ehr.createAppointment()            [mock EHR call]
             → ehr.getAppointment()                [VERIFY - don't trust our own write]
             → if verified: sync appointment.status = 'confirmed', mapping stored
             → if not verified / error: see Failure Handling below
         → on success: schedulingService.confirmSlotBooking()
         → emitEvent('appointment.confirmed', ...)  [workflow engine picks this up]
6. Workflow: assign_questionnaire, send_notification(s), wait, more notifications
7. AI replies to patient only once step 5 has actually resolved to confirmed or
   reconciliation_required - it never says "confirmed" before verification completes
```

## Failure handling & reconciliation (§13, §28)

`integrationLayer.js#createAppointmentWithVerification` implements the required
three-branch behavior:

| EHR outcome | Class | Behavior |
|---|---|---|
| Success + verified | — | confirm immediately |
| Success but verification returns not-found | — | treat as **unknown outcome**, open reconciliation (rare; the mock always writes before it would fail verification, but a real EHR's eventual consistency could hit this) |
| Timeout / network error | retryable-via-query | **query the EHR by idempotency key first** (`findAppointmentByIdempotencyKey`) — if found, sync safely (no duplicate); if not found, retry the create call itself (bounded, `MAX_CREATE_RETRIES = 2`), still using the same idempotency key |
| Auth / validation / rate-limit / outage | terminal | **no retry** — immediately open a `reconciliation_records` row and fire a `critical` `operational_events` row (`reconciliation.escalated`) |
| Retries exhausted | terminal | same as above |

The reserved slot is **not released** while an appointment is in
`reconciliation_required` — releasing it would let a second patient book on top of a
possibly-already-created external appointment. It's only released once a human
resolves the reconciliation record (or an automated re-sync confirms cancellation).

This is exercised by three integration tests:
`tests/integration/booking-chain.test.js` — "Option B" (timeout → safe recovery, zero
duplicates), "Option C" (validation error → reconciliation + critical escalation), and
a network-failure-then-successful-retry case.

## Security & tenant model (§21)

- JWT carries `role`, `hospitalId`, `doctorId`, `patientId` (`src/middleware/auth.js`)
- `requireRole(...)` gates by role; `requireOwnHospital(getHospitalId)` compares the
  JWT's `hospitalId` against the resource being accessed — **platform_admin bypasses
  this, every other role is hard-blocked from cross-tenant reads**, verified in
  `tests/integration/booking-chain.test.js` ("Tenant isolation") and manually via
  `curl` (hospital admin gets HTTP 403 reading another hospital's record)
- The capability registry has a second, independent tenant check
  (`capabilities/registry.js`) so that even AI-driven actions — which don't always
  go through an HTTP route with `requireOwnHospital` — are still tenant-scoped
- Passwords are hashed with `scrypt` (Node's built-in `crypto`, no plaintext, no
  external dependency); JWT secret and all future vendor credentials are read from
  environment variables only (`.env.example`), never hardcoded
- Audit metadata is sanitized (`auditService.js#sanitize`) to strip known
  clinical-content keys before writing to `audit_events`, per the "privacy-aware
  logging" requirement (§9, §19, §21)

## State management (§23)

Five kinds of state are kept in distinct tables, never merged into one JSON blob:

| Kind | Table(s) | Example |
|---|---|---|
| Transactional/business | `appointments`, `appointment_history` | appointment is `Confirmed` |
| Conversational | `ai_context` | currently selected doctor/slot in this chat |
| User context/preferences | `user_context` | preferred appointment time |
| Workflow | `workflow_executions` | a reminder scheduled to fire in 24h |
| Integration | `integration_operations`, `integration_verifications` | EHR appointment is `Verified` |
| Operational | `operational_events`, `reconciliation_records` | reconciliation is `Required` |

Each is independently queryable, auditable, and recoverable, matching the explicit
requirement not to store the whole application as one AI memory object.

## What a real deployment would change

- Swap `better-sqlite3` for Postgres (schema is portable; add connection pooling)
- Swap the in-process `setInterval` workflow poller for a durable queue (BullMQ/Redis)
- Add a real EHR connector implementing the same 7-function interface as `mockEhrConnector.js`
- Add a real speech pipeline in front of `POST /api/ai/conversations/:id/messages` (see `docs/AI.md`)
- Swap the rule-based NLU for an LLM using tool-use over the same capability registry
