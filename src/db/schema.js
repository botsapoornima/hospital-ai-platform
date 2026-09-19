// Full schema for the multi-tenant healthcare platform.
// Entities per PRD §22: Platform, Hospital, Hospital Admin/Staff, Department, Specialty,
// Doctor, Calendar, Availability, Blocked Slot, Patient, User Context/Preferences, Appointment,
// Questionnaire, Questionnaire Response, AI Conversation, AI Context, Capability,
// Capability Execution, Healthcare-System Connection, External Identifier Mapping,
// Integration Operation, Integration Verification, Reconciliation Record, Workflow,
// Workflow Execution, Notification, AI Evaluation, Audit Event, Operational Event.

export const SCHEMA_SQL = `
-- ===================== IDENTITY / TENANCY =====================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('platform_admin','hospital_admin','doctor','patient')),
  hospital_id TEXT,            -- NULL for platform_admin and patient (patients are cross-tenant)
  doctor_id TEXT,               -- set when role = doctor
  patient_id TEXT,              -- set when role = patient
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== HOSPITAL =====================
CREATE TABLE IF NOT EXISTS hospitals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','under_review','approved','rejected','suspended')),
  supported_healthcare_systems TEXT, -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specialties (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  name TEXT NOT NULL
);

-- ===================== DOCTOR / CALENDAR / AVAILABILITY =====================
CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  name TEXT NOT NULL,
  specialty_id TEXT REFERENCES specialties(id),
  department_id TEXT REFERENCES departments(id),
  qualifications TEXT,
  languages TEXT, -- JSON array
  consultation_types TEXT, -- JSON array e.g. ["in_person","video"]
  appointment_duration_minutes INTEGER NOT NULL DEFAULT 30,
  external_provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','active','inactive','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC'
);

-- Working hours as recurring weekly rules
CREATE TABLE IF NOT EXISTS working_hours (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  day_of_week INTEGER NOT NULL, -- 0=Sun..6=Sat
  start_time TEXT NOT NULL,     -- 'HH:MM'
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked_slots (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  start_at TEXT NOT NULL, -- ISO datetime
  end_at TEXT NOT NULL,
  reason TEXT
);

-- Concrete bookable slot instances (materialized from working hours minus blocked/booked)
CREATE TABLE IF NOT EXISTS slots (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  appointment_type TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reserved','booked')),
  version INTEGER NOT NULL DEFAULT 0, -- optimistic concurrency for conflict detection
  UNIQUE(doctor_id, start_at)
);

-- ===================== PATIENT =====================
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_phone TEXT,
  contact_email TEXT,
  date_of_birth TEXT,
  communication_preference TEXT DEFAULT 'sms',
  external_patient_id_map TEXT, -- JSON: { hospitalId: externalId }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_context (
  patient_id TEXT PRIMARY KEY REFERENCES patients(id),
  preferences TEXT NOT NULL DEFAULT '{}' -- JSON: preferred time, comms, etc (minimized)
);

-- ===================== APPOINTMENT =====================
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  slot_id TEXT NOT NULL REFERENCES slots(id),
  appointment_type TEXT NOT NULL DEFAULT 'general',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested','pending','confirmed','rescheduled','cancelled',
    'completed','no_show','failed','sync_pending','reconciliation_required'
  )),
  external_appointment_id TEXT,
  idempotency_key TEXT UNIQUE,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_history (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== QUESTIONNAIRE =====================
CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  name TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT '{}', -- JSON {specialtyId?, doctorId?, appointmentType?}
  questions TEXT NOT NULL, -- JSON array of {id, type, text, options?}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id),
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  responses TEXT NOT NULL DEFAULT '{}', -- JSON {questionId: answer}
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  escalated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== AI CONVERSATION / CONTEXT =====================
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  patient_id TEXT REFERENCES patients(id),
  channel TEXT NOT NULL DEFAULT 'web_chat' CHECK (channel IN ('web_chat','web_voice','telephone')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','escalated','abandoned')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('patient','ai','system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conversational + resolved context, kept separate from durable business state
CREATE TABLE IF NOT EXISTS ai_context (
  conversation_id TEXT PRIMARY KEY REFERENCES ai_conversations(id),
  intent TEXT,
  hospital_id TEXT,
  doctor_id TEXT,
  slot_id TEXT,
  appointment_id TEXT,
  slate TEXT NOT NULL DEFAULT '{}', -- JSON: candidate options presented to patient, symptoms text, etc
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== CAPABILITIES =====================
CREATE TABLE IF NOT EXISTS capability_executions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES ai_conversations(id),
  correlation_id TEXT NOT NULL,
  capability_name TEXT NOT NULL,
  input TEXT NOT NULL,   -- JSON
  output TEXT,           -- JSON
  status TEXT NOT NULL CHECK (status IN ('success','failed','denied')),
  error TEXT,
  actor_role TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== INTEGRATION / EHR =====================
CREATE TABLE IF NOT EXISTS healthcare_system_connections (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  connector_type TEXT NOT NULL DEFAULT 'mock_ehr',
  config TEXT NOT NULL DEFAULT '{}', -- JSON, no raw secrets - secret refs only
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS external_identifier_mappings (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('patient','doctor','appointment','facility')),
  internal_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hospital_id, entity_type, internal_id)
);

CREATE TABLE IF NOT EXISTS integration_operations (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  appointment_id TEXT REFERENCES appointments(id),
  correlation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL, -- create_appointment, update_appointment, cancel_appointment, etc
  idempotency_key TEXT,
  request_payload TEXT,
  response_payload TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending','success','failed','timeout','unknown','retrying'
  )),
  attempt INTEGER NOT NULL DEFAULT 1,
  error_class TEXT, -- timeout, network, auth, authz, rate_limit, outage, validation, mapping, conflict, duplicate, unknown
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS integration_verifications (
  id TEXT PRIMARY KEY,
  integration_operation_id TEXT NOT NULL REFERENCES integration_operations(id),
  appointment_id TEXT REFERENCES appointments(id),
  verified INTEGER NOT NULL DEFAULT 0,
  external_state TEXT, -- JSON snapshot from external system
  outcome TEXT NOT NULL CHECK (outcome IN ('found','not_found','ambiguous')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reconciliation_records (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id),
  appointment_id TEXT REFERENCES appointments(id),
  integration_operation_id TEXT REFERENCES integration_operations(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','escalated')),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- ===================== WORKFLOWS =====================
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  hospital_id TEXT REFERENCES hospitals(id), -- NULL = platform-level default
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL, -- e.g. appointment.confirmed
  steps TEXT NOT NULL, -- JSON array of step defs [{type, delaySeconds, condition?}]
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  correlation_id TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}', -- JSON
  current_step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting','completed','failed')),
  run_after TEXT, -- ISO datetime for delayed steps
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== NOTIFICATIONS =====================
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  hospital_id TEXT REFERENCES hospitals(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('patient','doctor','hospital')),
  recipient_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  category TEXT NOT NULL, -- confirmation, reminder, cancellation, etc
  content TEXT NOT NULL,
  correlation_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','queued')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== AI EVALUATION =====================
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES ai_conversations(id),
  metric TEXT NOT NULL, -- intent_accuracy, capability_success, escalation_rate, latency_ms
  value REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== AUDIT / OPERATIONAL EVENTS =====================
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT,
  hospital_id TEXT,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON, privacy-aware (no raw clinical content)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operational_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT,
  hospital_id TEXT,
  event_type TEXT NOT NULL, -- e.g. ehr.timeout, reconciliation.required, workflow.failed
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error','critical')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slots_doctor_status ON slots(doctor_id, status, start_at);
CREATE INDEX IF NOT EXISTS idx_appts_hospital ON appointments(hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_appts_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_intop_correlation ON integration_operations(correlation_id);
CREATE INDEX IF NOT EXISTS idx_doctors_hospital ON doctors(hospital_id, status);
`;

export function migrate(db) {
  db.exec(SCHEMA_SQL);
}
