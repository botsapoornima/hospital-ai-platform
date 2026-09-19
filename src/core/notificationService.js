import { db } from '../db/index.js';
import { newId } from '../utils/ids.js';

export function sendNotification({ hospitalId, recipientType, recipientId, channel = 'sms', category, content, correlationId }) {
  const id = newId('notif');
  // In a real system this would call an SMS/email/push provider. Here we just record it -
  // the point being demonstrated is that it's triggered correctly by workflow events.
  db.prepare(`
    INSERT INTO notifications (id, hospital_id, recipient_type, recipient_id, channel, category, content, correlation_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')
  `).run(id, hospitalId || null, recipientType, recipientId, channel, category, content, correlationId || null);
  return db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id);
}

export function listNotifications({ hospitalId, recipientId, limit = 100 } = {}) {
  let q = 'SELECT * FROM notifications WHERE 1=1';
  const params = [];
  if (hospitalId) { q += ' AND hospital_id = ?'; params.push(hospitalId); }
  if (recipientId) { q += ' AND recipient_id = ?'; params.push(recipientId); }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(q).all(...params);
}
