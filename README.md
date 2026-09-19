# Hospital AI Platform (Prototype)

A multi-tenant healthcare access platform where patients describe what they need in
natural language, an AI agent resolves intent and context, checks **real** availability,
books through a controlled capability layer, integrates with a mock EHR, **verifies**
the external result before confirming, synchronizes internal state, and triggers
pre-visit questionnaires and follow-up workflows — all observable end-to-end by
hospital and platform operators.

Built to the spec in `Project_Requirements.pdf` (multi-hospital patient intake,
scheduling & pre-visit voice agent, v2.0).

## What this demonstrates

```
Patient message → AI intent + context → Doctor discovery → Real availability →
Reserve + book → Mock EHR create → Verify external record → Sync internal state →
Confirm → Assign questionnaire → Notify → Workflow → Doctor/Admin dashboards
```

...and, critically, the **failure path**: when the EHR call times out, the system
does not blindly retry (which could create a duplicate appointment). It queries the
external system by idempotency key first, and only then either syncs safely or opens
a reconciliation record for human follow-up. All three failure modes named in the
spec are implemented and tested — see `tests/integration/booking-chain.test.js`.

## Features

- **Multi-tenant hospital onboarding**: draft → submitted → under review → approved/rejected, suspend/reactivate
- **Doctor & calendar configuration**: specialties, departments, working hours, blocked periods
- **Real scheduling engine**: slots are materialized from working hours, never invented; atomic reservation prevents concurrent double-booking
- **AI patient-access agent**: identity resolution, symptom→specialty routing, timeframe parsing, clarification, context carry-over ("make that Friday"), safety boundaries (refuses diagnosis/prescription requests), urgent-signal escalation
- **Capability layer**: the AI's only interface to the system — every action is schema-validated, authorized, tenant-isolated, and audited
- **Mock EHR + integration layer**: patient/provider/appointment mapping, create/update/cancel/verify, with injectable failure modes for demos
- **Verification & reconciliation**: create → verify → sync → confirm; unknown-outcome recovery via idempotent re-query; reconciliation records + operational escalation for unresolved cases
- **Workflows**: event-triggered, support delayed steps (reminders), assign questionnaires, send notifications
- **Pre-visit questionnaires**: hospital-configured, blocked from containing diagnostic/prescriptive questions, with urgent-language escalation flagging
- **Dashboards**: platform admin, hospital admin, doctor, patient (AI chat)
- **Full observability**: audit log, operational events, capability execution log, correlation-ID tracing across every layer
- **Tenant isolation**: enforced at the middleware and capability layer, tested

## Tech stack & why

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js + Express | fast to build a layered API in, huge ecosystem, easy to containerize |
| Database | SQLite (better-sqlite3) | zero-ops for a prototype, synchronous API removes a whole class of race bugs, trivial to swap for Postgres later (schema is plain SQL) |
| Auth | JWT | stateless, simple to reason about across 4 roles |
| AI | Rule-based NLU (this prototype) / Claude Messages API with tool-use (production path) | see `docs/AI.md` — the capability-calling architecture is identical either way |
| Frontend | Static HTML + vanilla JS | no build step, keeps the prototype's frontend from competing with the backend for the 3-4 day budget, while still exercising every API layer |
| Voice | Interface-contract only in this prototype | see "What's not real" below |

## Project layout

```
server.js                     Express entrypoint
src/
  db/                          schema.js (all entities), index.js (connection), seed.js (demo data)
  core/                        hospitalService, doctorService, schedulingService, patientService,
                                appointmentService, questionnaireService, notificationService,
                                userService, auditService
  ai/                          agent.js (conversation loop), nlu.js, contextManager.js, symptomMap.js
  capabilities/                registry.js (execution/auth/audit wrapper), definitions.js (the actual capabilities)
  integration/                 mockEhrConnector.js (the only vendor-specific code), integrationLayer.js (verify/reconcile)
  workflows/                   engine.js (event-triggered async workflows)
  middleware/                  auth.js (JWT, role, tenant isolation)
  routes/                      authRoutes, hospitalRoutes, patientRoutes, aiRoutes, adminRoutes, demoRoutes
public/                        static dashboards (index/patient/admin/hospital/doctor .html + api.js/style.css)
tests/unit, tests/integration   see Testing below
docs/ARCHITECTURE.md, docs/AI.md
```

## Setup

```bash
npm install
npm run seed     # wipes and recreates data/platform.db with demo hospitals, doctors, a patient
npm start         # http://localhost:3000
```

Open `http://localhost:3000` in a browser.

### Demo accounts (from seed)

| Role | Email | Password |
|---|---|---|
| Platform admin | admin@platform.dev | admin123 |
| Riverside hospital admin | admin@riverside.example | admin123 |
| Riverside doctor (Dr. Rao) | rao@riverside.example | doctor123 |
| Lakeside hospital admin | admin@lakeside.example | admin123 |

Patients don't have passwords in this prototype — the AI identifies them by phone
number in conversation (seeded patient: **Jordan Smith, +1-555-9999**), matching how
a real telephone/voice flow would work. Open `patient.html` and try:

> "This is Jordan Smith, my number is +1-555-9999"
> "I need to see a doctor for my shoulder pain sometime this week"

### Environment variables

See `.env.example`. None are required to run the demo (JWT_SECRET defaults to a
dev value — **change it in any real deployment**).

## Tests

```bash
npm test
```

13 tests across `tests/unit` (availability calculation, slot conflict, appointment
state transitions, idempotency, questionnaire safety rules, escalation flagging) and
`tests/integration` (full booking chain end-to-end, concurrent double-booking
rejection, **all three PRD-required failure/recovery scenarios**, network-failure
retry, tenant isolation, delayed workflow timing).

## The required failure/recovery demonstration

Use `POST /api/demo/failure-injection/:hospitalId` with `{ "mode": "timeout" | "network" | "auth" | "validation" | "rate_limit", "times": 1 }`
before triggering a booking (via the AI chat or `POST` to create an appointment), then
inspect `GET /api/admin/trace/:correlationId` to see the full chain react:

- `mode: "timeout"` → **Option B (unknown outcome)**: the integration layer does not
  retry blindly; it queries the EHR by idempotency key, finds the record was actually
  created, and syncs safely with **zero duplicate appointments**.
- `mode: "validation"` (or `"auth"`) → **Option C (unrecoverable)**: retries are not
  attempted for terminal error classes; a reconciliation record opens immediately and
  an `reconciliation.escalated` critical operational event fires.
- `mode: "network"` → **Option A (retry then recover)**: retried once automatically
  (bounded), succeeds, single appointment created.

This is exercised automatically in `tests/integration/booking-chain.test.js`.

## Known limitations

- **Voice/telephone is not wired to a real speech vendor.** The AI agent, capability
  layer, and conversation/context model are channel-agnostic by design (`channel`
  field on conversations already distinguishes `web_chat` / `web_voice` / `telephone`),
  but this prototype's live interface is text chat. Wiring a real STT/TTS/telephony
  vendor (e.g. Twilio + Deepgram, or a WebRTC + streaming ASR stack) would sit in
  front of `POST /api/ai/conversations/:id/messages` without touching the agent logic
  underneath. See `docs/AI.md`.
- **NLU is rule-based, not an LLM**, for this prototype (no outbound LLM API access in
  the build environment used to produce this repo). `docs/AI.md` documents exactly
  where an LLM (e.g. Claude with tool-use) would slot in — the capability registry
  interface would not change.
- **Not deployed publicly.** Run locally per Setup above, or deploy the container to
  any Node host (Render, Railway, Fly.io, a VM) — `server.js` reads `PORT` from the
  environment already.
- **Workflow scheduling** uses an in-process `setInterval` poller (`tickWorkflows`),
  not a durable job queue — fine for a prototype/demo, not for production scale.
- **Single mock EHR connector.** The integration layer and connector interface are
  vendor-agnostic by construction (see `docs/ARCHITECTURE.md`), but only the mock is
  implemented.

## Future improvements

- Real speech-to-text/text-to-speech + telephony connector behind the existing
  conversation API
  - Swap the rule-based NLU for an LLM (Claude) using tool-use over the exact same
  capability registry
- A real job queue (BullMQ/Redis) for workflow execution instead of the in-process poller
- Postgres + row-level security for stronger tenant isolation at the DB layer
- A real EHR connector (e.g. a FHIR-based one) implementing the same connector interface
- AI evaluation harness (intent accuracy, capability selection accuracy) beyond the
  `ai_evaluations` table scaffold already in the schema
