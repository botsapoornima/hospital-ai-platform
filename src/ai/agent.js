import * as ctx from './contextManager.js';
import * as nlu from './nlu.js';
import { inferSpecialty, containsUrgentSignal, isClinicalRequest } from './symptomMap.js';
import { executeCapability } from '../capabilities/registry.js';
import * as patientService from '../core/patientService.js';
import { newCorrelationId } from '../utils/ids.js';
import { db } from '../db/index.js';

// The AI agent never imports core services or the EHR connector directly - every
// action it takes on the system flows through executeCapability (PRD §10).

const ACTOR = { role: 'patient' }; // in-conversation actions execute with patient-level authorization

export async function handleMessage(conversationId, text) {
  ctx.addMessage(conversationId, 'patient', text);
  const conversation = ctx.getConversation(conversationId);
  const context = ctx.getContext(conversationId);
  const correlationId = context.slate.correlationId || newCorrelationId();
  if (!context.slate.correlationId) ctx.updateContext(conversationId, { slate: { correlationId } });

  const reply = await route({ conversationId, conversation, context, text, correlationId });
  ctx.addMessage(conversationId, 'ai', reply.text);
  return reply;
}

async function route({ conversationId, conversation, context, text, correlationId }) {
  // Safety boundary: never diagnose/prescribe/recommend treatment (PRD §20).
  if (isClinicalRequest(text)) {
    return { text: "I'm an administrative assistant, so I can't answer clinical questions like that - only a clinician can. I can help you book, reschedule, or check an appointment though. Would you like to do one of those?" };
  }
  if (containsUrgentSignal(text)) {
    await executeCapability('transfer_to_human', { conversationId, reason: 'urgent_signal_detected' }, ACTOR, { correlationId, conversationId });
    return { text: "This sounds like it could be urgent. If you're in a medical emergency, please call your local emergency number right away. I'm connecting you to a human for anything urgent - I'm not able to assess medical urgency myself.", escalated: true };
  }

  const stage = context.slate.stage || (conversation.patient_id ? 'idle' : 'need_identity');

  // ---- Identity resolution ----
  if (stage === 'need_identity') {
    return await handleIdentity({ conversationId, text, correlationId });
  }

  const intent = nlu.detectIntent(text, !!context.appointment_id);

  if (stage === 'presenting_options') {
    return await handleOptionSelection({ conversationId, context, text, correlationId });
  }
  if (stage === 'need_confirmation') {
    return await handleConfirmation({ conversationId, context, text, correlationId });
  }
  if (stage === 'need_timeframe') {
    return await handleTimeframe({ conversationId, context, text, correlationId });
  }
  if (stage === 'need_reschedule_timeframe') {
    return await handleRescheduleTimeframe({ conversationId, context, text, correlationId });
  }

  // ---- Fresh intent detection ----
  if (intent === 'greeting') {
    return { text: "Hi! I can help you find a doctor and book an appointment. What do you need help with?" };
  }
  if (intent === 'human_escalation') {
    await executeCapability('transfer_to_human', { conversationId, reason: 'patient_requested' }, ACTOR, { correlationId, conversationId });
    return { text: "Of course - connecting you with a human team member now.", escalated: true };
  }
  if (intent === 'check_status') {
    return await handleCheckStatus({ conversationId, context, correlationId });
  }
  if (intent === 'cancel_appointment') {
    return await handleCancelIntent({ conversationId, context, text, correlationId });
  }
  if (intent === 'reschedule_appointment') {
    return await handleRescheduleIntent({ conversationId, context, correlationId });
  }
  if (intent === 'book_appointment') {
    return await handleBookIntent({ conversationId, context, text, correlationId });
  }

  return { text: "I can help you find a doctor and book, reschedule, or cancel an appointment, or check an existing one. What would you like to do?" };
}

async function handleIdentity({ conversationId, text, correlationId }) {
  const phoneMatch = text.match(/(\+?\d[\d\-\s]{7,}\d)/);
  const nameMatch = text.match(/(?:my name is|i'?m|this is)\s+([a-zA-Z ]{2,40})/i);
  if (phoneMatch) {
    let patient = patientService.findPatientByContact({ contactPhone: phoneMatch[1].trim() });
    if (!patient) {
      patient = patientService.registerPatient({ name: nameMatch ? nameMatch[1].trim() : 'New Patient', contactPhone: phoneMatch[1].trim() });
    }
    ctx.linkPatient(conversationId, patient.id);
    ctx.updateContext(conversationId, { slate: { stage: 'idle' } });
    return { text: `Thanks${nameMatch ? ', ' + nameMatch[1].trim() : ''}! I've found your account. What can I help you with - booking, rescheduling, cancelling, or checking an appointment?` };
  }
  return { text: "Before we get started, could I get your phone number to pull up (or create) your patient record?" };
}

async function handleBookIntent({ conversationId, context, text, correlationId }) {
  const specialty = inferSpecialty(text);
  const timeframe = nlu.parseTimeframe(text);

  const slate = { ...context.slate, rawRequest: text, specialty };

  if (!timeframe) {
    ctx.updateContext(conversationId, { intent: 'book_appointment', slate: { ...slate, stage: 'need_timeframe' } });
    return { text: specialty
      ? `Got it - ${specialty.toLowerCase()} sounds right for that. When would you like to come in? (e.g. "today", "this week", "Friday")`
      : `I can help with that. When would you like to come in, and do you know what kind of specialist you need?` };
  }
  return await searchAndPresent({ conversationId, specialty, timeframe, correlationId });
}

async function handleTimeframe({ conversationId, context, text, correlationId }) {
  const timeframe = nlu.parseTimeframe(text);
  const specialty = context.slate.specialty || inferSpecialty(text);
  if (!timeframe) {
    return { text: `I didn't catch a timeframe - could you say something like "today", "this week", or a day like "Friday"?` };
  }
  return await searchAndPresent({ conversationId, specialty, timeframe, correlationId });
}

async function searchAndPresent({ conversationId, specialty, timeframe, correlationId }) {
  const doctors = await executeCapability('search_doctors', { specialty: specialty || undefined }, ACTOR, { correlationId, conversationId });
  if (doctors.length === 0) {
    ctx.updateContext(conversationId, { slate: { stage: 'idle' } });
    return { text: `I couldn't find an available ${specialty || 'matching'} doctor right now. Would you like to try a different specialty or hospital?` };
  }

  let allSlots = [];
  for (const doc of doctors) {
    const slots = await executeCapability('check_availability', { doctorId: doc.id, fromISO: timeframe.fromISO, toISO: timeframe.toISO }, ACTOR, { correlationId, conversationId });
    allSlots.push(...slots);
  }
  allSlots = allSlots.slice(0, 4);

  if (allSlots.length === 0) {
    ctx.updateContext(conversationId, { slate: { stage: 'idle' } });
    return { text: `I checked real availability but couldn't find an open slot ${timeframe.label}. Want me to check a different timeframe?` };
  }

  const optionsText = allSlots.map((s, i) => `${i + 1}. ${docLabel(s.doctorName)} - ${formatDateTime(s.startAt)}`).join('\n');
  ctx.updateContext(conversationId, { slate: { stage: 'presenting_options', options: allSlots } });
  return { text: `Here's real availability ${timeframe.label}:\n${optionsText}\n\nWhich would you like?` };
}

async function handleOptionSelection({ conversationId, context, text, correlationId }) {
  const options = context.slate.options || [];
  const idx = nlu.parseChoice(text, options.length);
  if (idx === null) {
    return { text: `Sorry, which option would you like - please say the number (1-${options.length})?` };
  }
  const chosen = options[idx];
  ctx.updateContext(conversationId, { slate: { stage: 'need_confirmation', pendingSlot: chosen } });
  return { text: `Just to confirm: ${docLabel(chosen.doctorName)} at ${formatDateTime(chosen.startAt)}. Shall I book it?` };
}

async function handleConfirmation({ conversationId, context, text, correlationId }) {
  if (nlu.isNegative(text)) {
    ctx.updateContext(conversationId, { slate: { stage: 'idle', pendingSlot: null } });
    return { text: "No problem, I won't book that. Anything else I can help with?" };
  }
  if (!nlu.isAffirmative(text)) {
    return { text: `Sorry, should I go ahead and book that appointment? (yes/no)` };
  }
  const pending = context.slate.pendingSlot;
  const conversation = ctx.getConversation(conversationId);

  try {
    const result = await executeCapability('create_appointment', {
      patientId: conversation.patient_id, doctorId: pending.doctorId, slotId: pending.slotId, correlationId,
    }, ACTOR, { correlationId, conversationId });

    if (result.appointment.status === 'confirmed') {
      ctx.updateContext(conversationId, { appointment_id: result.appointment.id, slate: { stage: 'idle', pendingSlot: null } });
      return { text: `You're all set! Your appointment with ${docLabel(pending.doctorName)} at ${formatDateTime(pending.startAt)} is confirmed. You'll get a confirmation message shortly, and I may follow up with a short pre-visit questionnaire.` };
    }
    if (result.appointment.status === 'reconciliation_required') {
      ctx.updateContext(conversationId, { appointment_id: result.appointment.id, slate: { stage: 'idle', pendingSlot: null } });
      return { text: `I've submitted your booking request, but I wasn't able to immediately confirm it with the hospital's system. Our team has been notified and will confirm shortly - I don't want to tell you it's confirmed until it's verified. I'm sorry for the inconvenience.` };
    }
    return { text: `Something went wrong booking that slot. Would you like to try a different time?` };
  } catch (err) {
    ctx.updateContext(conversationId, { slate: { stage: 'idle', pendingSlot: null } });
    if (err.code === 'SLOT_UNAVAILABLE') {
      return { text: `Sorry, that slot was just taken by another patient. Would you like me to check availability again?` };
    }
    return { text: `I wasn't able to complete that booking (${err.message}). Would you like to try again?` };
  }
}

async function handleCheckStatus({ conversationId, context, correlationId }) {
  const conversation = ctx.getConversation(conversationId);
  if (!conversation.patient_id) return { text: "I don't have your account pulled up yet - what's your phone number?" };
  const appts = await patientService.listAppointmentsForPatient(conversation.patient_id);
  if (appts.length === 0) return { text: "You don't have any appointments on file yet. Want to book one?" };
  const lines = appts.slice(0, 5).map(a => `- ${docLabel(a.doctor_name)} at ${a.hospital_name}, ${formatDateTime(a.start_at)} (${a.status})`);
  return { text: `Here's what I have:\n${lines.join('\n')}` };
}

async function handleCancelIntent({ conversationId, context, text, correlationId }) {
  const conversation = ctx.getConversation(conversationId);
  if (!conversation.patient_id) return { text: "What's your phone number so I can find your appointment?" };
  const appts = (await patientService.listAppointmentsForPatient(conversation.patient_id)).filter(a => ['confirmed', 'pending', 'rescheduled'].includes(a.status));
  if (appts.length === 0) return { text: "I don't see any active appointments to cancel." };
  const target = appts[0];
  const result = await executeCapability('cancel_appointment', { appointmentId: target.id, reason: 'patient_requested', correlationId }, ACTOR, { correlationId, conversationId });
  if (result.result.status === 'cancelled') {
    return { text: `Done - your appointment with ${docLabel(target.doctor_name)} on ${formatDateTime(target.start_at)} has been cancelled.` };
  }
  return { text: `I've submitted the cancellation, but couldn't immediately confirm it with the hospital's system - our team will follow up.` };
}

async function handleRescheduleIntent({ conversationId, context, correlationId }) {
  const conversation = ctx.getConversation(conversationId);
  if (!conversation.patient_id) return { text: "What's your phone number so I can find your appointment?" };
  const appts = (await patientService.listAppointmentsForPatient(conversation.patient_id)).filter(a => ['confirmed', 'pending', 'rescheduled'].includes(a.status));
  if (appts.length === 0) return { text: "I don't see any active appointments to reschedule." };
  const target = appts[0];
  ctx.updateContext(conversationId, { slate: { stage: 'need_reschedule_timeframe', rescheduleAppointmentId: target.id, rescheduleDoctorId: target.doctor_id } });
  return { text: `Sure - your appointment with ${docLabel(target.doctor_name)} is currently ${formatDateTime(target.start_at)}. What day would you like instead?` };
}

async function handleRescheduleTimeframe({ conversationId, context, text, correlationId }) {
  const timeframe = nlu.parseTimeframe(text);
  if (!timeframe) return { text: `What day works better - e.g. "Friday" or "next week"?` };
  const doctorId = context.slate.rescheduleDoctorId;
  const slots = await executeCapability('check_availability', { doctorId, fromISO: timeframe.fromISO, toISO: timeframe.toISO }, ACTOR, { correlationId, conversationId });
  if (slots.length === 0) return { text: `No real openings ${timeframe.label} for that doctor - want to try another day?` };
  const top = slots[0];
  const appointmentId = context.slate.rescheduleAppointmentId;
  const result = await executeCapability('reschedule_appointment', { appointmentId, newSlotId: top.slotId, correlationId }, ACTOR, { correlationId, conversationId });
  ctx.updateContext(conversationId, { slate: { stage: 'idle' } });
  if (result.result.status === 'rescheduled') {
    return { text: `Rescheduled to ${formatDateTime(top.startAt)} with ${docLabel(top.doctorName)}.` };
  }
  return { text: `I've submitted the reschedule but couldn't immediately confirm it - our team will follow up.` };
}

function docLabel(name) {
  if (!name) return 'the doctor';
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toUTCString().replace(':00 GMT', ' UTC');
  } catch {
    return iso;
  }
}
