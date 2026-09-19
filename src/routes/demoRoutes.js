import { Router } from 'express';
import { setFailureInjection, clearFailureInjection } from '../integration/mockEhrConnector.js';
import { tickWorkflows } from '../workflows/engine.js';

export const demoRoutes = Router();

// Injects a failure mode into the mock EHR for the next N calls to that hospital.
// mode: 'timeout' (unknown outcome), 'network', 'auth', 'validation', 'rate_limit', 'outage'
demoRoutes.post('/failure-injection/:hospitalId', (req, res) => {
  const { mode, times } = req.body;
  setFailureInjection(req.params.hospitalId, mode, times || 1);
  res.json({ injected: mode, hospitalId: req.params.hospitalId, times: times || 1 });
});

demoRoutes.delete('/failure-injection/:hospitalId', (req, res) => {
  clearFailureInjection(req.params.hospitalId);
  res.json({ cleared: true });
});

// Manually advances the workflow scheduler (normally polled on an interval) so a demo
// doesn't have to wait for real time to pass.
demoRoutes.post('/tick-workflows', (req, res) => {
  res.json({ processed: tickWorkflows() });
});
