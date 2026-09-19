import { Router } from 'express';
import * as userService from '../core/userService.js';
import { signToken } from '../middleware/auth.js';

export const authRoutes = Router();

authRoutes.post('/login', (req, res) => {
  const { email, password } = req.body;
  try {
    const user = userService.login(email, password);
    const token = signToken(user);
    res.json({ token, user: { id: user.id, role: user.role, name: user.name, hospitalId: user.hospital_id, doctorId: user.doctor_id, patientId: user.patient_id } });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});
