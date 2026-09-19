import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { AppError } from './hospitalService.js';

export function createUser({ role, hospitalId, doctorId, patientId, email, password, name }) {
  const id = newId('user');
  db.prepare(`
    INSERT INTO users (id, role, hospital_id, doctor_id, patient_id, email, password_hash, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, role, hospitalId || null, doctorId || null, patientId || null, email, hashPassword(password), name);
  return getUser(id);
}

export function getUser(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

export function login(email, password) {
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
  }
  return user;
}
