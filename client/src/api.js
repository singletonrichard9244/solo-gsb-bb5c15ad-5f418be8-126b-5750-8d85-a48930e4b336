const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    if (data.code) err.code = data.code;
    if (data.details) err.details = data.details;
    throw err;
  }
  return data;
}

export const api = {
  getState: () => request('/state'),
  createContext: (body) => request('/contexts', { method: 'POST', body: JSON.stringify(body) }),
  updateContext: (id, body) => request(`/contexts/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteContext: (id) => request(`/contexts/${id}`, { method: 'DELETE' }),
  createCommand: (body) => request('/commands', { method: 'POST', body: JSON.stringify(body) }),
  updateCommand: (id, body) => request(`/commands/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteCommand: (id) => request(`/commands/${id}`, { method: 'DELETE' }),
  review: (contextId) => request(`/review/${contextId}`),
  simulate: (contextId, buffer) =>
    request(`/simulate/${contextId}`, { method: 'POST', body: JSON.stringify({ buffer }) }),
  replay: (contextId, body) =>
    request(`/replay/${contextId}`, { method: 'POST', body: JSON.stringify(body) }),
  regressionSuite: () => request('/regression-suite'),
  sandboxPreview: (draft) =>
    request('/sandbox/preview', { method: 'POST', body: JSON.stringify(draft) }),
  sandboxPublish: (draft, fingerprint) =>
    request('/sandbox/publish', { method: 'POST', body: JSON.stringify({ draft, fingerprint }) }),
  resolveConflicts: (contextId, body) =>
    request(`/conflicts/resolve/${contextId}`, { method: 'POST', body: JSON.stringify(body) }),
};
