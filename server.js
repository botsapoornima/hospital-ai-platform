import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './src/db/index.js';
import { migrate } from './src/db/schema.js';
import './src/capabilities/definitions.js'; // side-effect: registers all capabilities
import { authRoutes } from './src/routes/authRoutes.js';
import { hospitalRoutes } from './src/routes/hospitalRoutes.js';
import { patientRoutes, doctorSelfRoutes } from './src/routes/patientRoutes.js';
import { aiRoutes } from './src/routes/aiRoutes.js';
import { adminRoutes } from './src/routes/adminRoutes.js';
import { demoRoutes } from './src/routes/demoRoutes.js';
import { tickWorkflows } from './src/workflows/engine.js';

migrate(db);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/hospitals', hospitalRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/doctors', doctorSelfRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/demo', demoRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error', message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hospital AI Platform listening on port ${PORT}`);
});

// Poll for delayed workflow steps (reminders, etc). In production this would be a
// proper job queue (e.g. BullMQ) rather than an in-process interval.
setInterval(() => tickWorkflows(), 2000);
