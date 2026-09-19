import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';

export function signToken(user) {
  return jwt.sign({
    sub: user.id, role: user.role, hospitalId: user.hospital_id || null,
    doctorId: user.doctor_id || null, patientId: user.patient_id || null, name: user.name,
  }, JWT_SECRET, { expiresIn: '12h' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.actor = { id: payload.sub, role: payload.role, hospitalId: payload.hospitalId, doctorId: payload.doctorId, patientId: payload.patientId, name: payload.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.actor || !roles.includes(req.actor.role)) {
      return res.status(403).json({ error: `Requires one of roles: ${roles.join(', ')}` });
    }
    next();
  };
}

// Tenant isolation: if a route param/body references a hospitalId, and the actor is
// scoped to a hospital, it must match. Platform admins bypass this check.
export function requireOwnHospital(getHospitalId) {
  return (req, res, next) => {
    if (req.actor.role === 'platform_admin') return next();
    const targetHospitalId = getHospitalId(req);
    if (!targetHospitalId || targetHospitalId !== req.actor.hospitalId) {
      return res.status(403).json({ error: 'Cannot access another hospital\'s data' });
    }
    next();
  };
}
