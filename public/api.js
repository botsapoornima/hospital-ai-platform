const API = {
  base: '',
  token() { return localStorage.getItem('token'); },
  user() { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } },
  setSession(token, user) { localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); },
  clearSession() { localStorage.removeItem('token'); localStorage.removeItem('user'); },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const res = await fetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  del(path) { return this.request('DELETE', path); },
};

function requireLogin(allowedRoles) {
  const user = API.user();
  if (!API.token() || !user || (allowedRoles && !allowedRoles.includes(user.role))) {
    window.location.href = '/index.html';
    return null;
  }
  return user;
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toUTCString().replace(':00 GMT', ' UTC'); } catch { return iso; }
}

function badge(status) {
  return `<span class="badge ${status}">${status.replace(/_/g, ' ')}</span>`;
}

function logout() { API.clearSession(); window.location.href = '/index.html'; }
