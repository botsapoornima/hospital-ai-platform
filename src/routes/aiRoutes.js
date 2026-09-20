import { Router } from 'express';
import * as ctx from '../ai/contextManager.js';
import { handleMessage } from '../ai/agent.js';
import * as patientService from '../core/patientService.js';

export const aiRoutes = Router();

// Starts a new conversation. channel: web_chat | web_voice | telephone (interface contract
// is identical across channels - only the transport differs; see docs/AI.md).
aiRoutes.post('/conversations', (req, res) => {
  const conversation = ctx.startConversation({
    patientId: req.body.patientId,
    channel: req.body.channel || 'web_chat'
  });

  res.status(201).json(conversation);
});

aiRoutes.post('/conversations/:id/messages', async (req, res) => {
  try {
    const reply = await handleMessage(
      req.params.id,
      req.body.text
    );

    res.json(reply);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

aiRoutes.get('/conversations/:id/messages', (req, res) => {
  res.json(ctx.getMessages(req.params.id));
});

aiRoutes.get('/conversations/:id', (req, res) => {
  res.json({
    conversation: ctx.getConversation(req.params.id),
    context: ctx.getContext(req.params.id)
  });
});

// Patient appointments for the no-login AI conversation flow
aiRoutes.get('/conversations/:id/appointments', (req, res) => {
  const conversation = ctx.getConversation(req.params.id);

  if (!conversation || !conversation.patient_id) {
    return res.json([]);
  }

  res.json(
    patientService.listAppointmentsForPatient(
      conversation.patient_id
    )
  );
});