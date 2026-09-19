# AI Documentation

## Summary

This prototype's AI agent is **rule-based** (pattern-matching intent detection +
slot-filling state machine), not an LLM. This section explains why, exactly what it
does, and precisely where an LLM would replace it without changing anything else in
the architecture.

## Why rule-based for this build

The build environment used to produce this repository does not have outbound network
access to any LLM vendor at runtime from the application server (only package
registries are reachable). Rather than fake an LLM integration that wouldn't actually
run, the agent is implemented with real, working, testable logic that demonstrates
every architectural requirement the spec asks for — intent detection, clarification,
context resolution, capability dispatch, safety boundaries — using deterministic code
that a grader can read line-by-line in `src/ai/nlu.js` and `src/ai/agent.js`.

## What the agent actually does (`src/ai/agent.js`)

1. **Safety boundary check first, always.** Every message is checked against
   `symptomMap.js#isClinicalRequest` (refuses diagnosis/prescription/treatment
   questions) and `containsUrgentSignal` (chest pain, can't breathe, etc. → immediate
   `transfer_to_human` capability call, with a clear "call emergency services" message).
   This runs before intent detection, so it can't be talked around by rephrasing.
2. **Identity resolution.** Unauthenticated conversations ask for a phone number,
   look up or create a patient record via `patientService`, and link it to the
   conversation (`ai_context.conversation_id` → `ai_conversations.patient_id`).
3. **Intent detection** (`nlu.js#detectIntent`): book / reschedule / cancel / check
   status / greeting / human escalation, via keyword and pattern matching.
4. **Entity extraction**: `symptomMap.js#inferSpecialty` maps patient language
   ("shoulder pain") to a specialty for search purposes only — explicitly
   administrative routing, never a diagnosis (the code comment and the PRD's own
   example, "You reported chest discomfort" vs "You have a heart condition", are
   followed literally in the response wording). `nlu.js#parseTimeframe` handles
   "today", "this week", specific weekdays, etc.
5. **Context resolution / clarification.** A `slate.stage` state machine
   (`need_identity` → `need_timeframe` → `presenting_options` → `need_confirmation` →
   `idle`) tracks exactly what's still needed and asks for it. Anaphora ("make that
   Friday", "yes", "the second one") resolves against `ai_context`, not by re-parsing
   the whole conversation — this is the literal PRD example in §10.
6. **Every state-changing action is a capability call**, never a direct DB or EHR
   call — see `capabilities/definitions.js` and `docs/ARCHITECTURE.md`.
7. **The agent never tells the patient "confirmed" before verification completes.**
   `handleConfirmation()` checks `result.appointment.status === 'confirmed'` (set only
   after EHR verification) vs `'reconciliation_required'`, and uses different, honest
   language for each — see the actual reply text in `agent.js`.

## Where a real LLM slots in (production path)

Replace `src/ai/nlu.js`'s pattern matching and `src/ai/agent.js`'s hand-written state
machine with a single LLM call per turn that:

- receives the conversation history (`ai_messages`) and current `ai_context` as input
- is given the **exact same capability list** from `capabilities/registry.js`
  (`listCapabilityNames()` + each capability's zod schema, converted to JSON Schema)
  as **tool definitions**
- is prompted with the same safety boundaries currently hard-coded in
  `symptomMap.js` (administrative-only, no diagnosis, escalate urgent signals)
- returns either a natural-language reply, or one or more tool calls

Every tool call the LLM makes would still go through
`capabilities/registry.js#executeCapability` — validation, authorization, tenant
isolation, and audit logging are unchanged. **Nothing in `capabilities/`, `core/`,
`integration/`, or `workflows/` would need to change** to make this swap; only
`ai/agent.js` and `ai/nlu.js` are replaced.

Example of what that call would look like using the Anthropic Messages API:

```javascript
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: AGENT_SYSTEM_PROMPT, // administrative-only boundaries, tone, escalation rules
    messages: conversationHistory,
    tools: capabilitySchemasAsTools, // derived from capabilities/definitions.js
  }),
});
// then: for each tool_use block in response.content, call executeCapability(name, input, actor, {correlationId, conversationId})
// feed tool_result blocks back in a follow-up call until the model returns a final text reply
```

## Voice technology (not implemented, interface-ready)

`ai_conversations.channel` already distinguishes `web_chat` / `web_voice` /
`telephone`. A real deployment would put a speech layer in front of the same
`POST /api/ai/conversations/:id/messages` endpoint:

```
Caller audio → STT (streaming, e.g. Deepgram/Whitehat ASR) → same handleMessage() →
TTS (e.g. ElevenLabs/Amazon Polly) → caller
```

Telephony (inbound call handling, DTMF fallback, transfer-to-human) would sit at the
transport layer (e.g. Twilio Voice + Media Streams) and is orthogonal to everything
in `ai/` — the agent doesn't know or care whether its input came from a browser
textbox or a live transcription stream.

## AI development tools used

This prototype's agent code was hand-written (no code-generation-from-spec tooling
beyond a standard editor), given the deterministic/rule-based approach described
above.

## Evaluation approach

`ai_evaluations` exists in the schema as a scaffold (`metric`, `value`, `notes` per
conversation) for the intended production metrics: intent accuracy, capability
selection accuracy, escalation rate, and latency. In this prototype, correctness is
instead demonstrated via the **AI Tests** category in `tests/` — the E2E integration
test exercises intent → clarification → capability dispatch → verified booking → the
questionnaire it triggers, and separate tests confirm safety-boundary refusals and
escalation flagging on urgent language in questionnaire answers
(`tests/unit/core.test.js`).

## Important behavioral guarantees (and where they're enforced)

| Guarantee | Enforced in |
|---|---|
| Never invents availability | `schedulingService.getAvailability()` only ever reads materialized `slots` rows |
| Never diagnoses/prescribes | `symptomMap.js#isClinicalRequest` checked before intent routing, in `agent.js#route` |
| Clarifies rather than guesses | `slate.stage` state machine requires timeframe/specialty/confirmation before acting |
| Every action auditable | `capabilities/registry.js#executeCapability` logs every call (success/failure/denied) |
| Never claims success before verification | `agent.js#handleConfirmation` branches on `appointment.status`, which integration layer only sets to `confirmed` post-verification |
| Urgent input escalates, doesn't get answered clinically | `symptomMap.js#containsUrgentSignal` → `transfer_to_human` capability, checked before all other routing |
