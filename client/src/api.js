// Simple API client and configuration for the frontend.
// Centralizes the backend base URL and common request helpers.

const API_ORIGIN =
  typeof process !== 'undefined' && process.env && typeof process.env.API_BASE !== 'undefined'
    ? process.env.API_BASE
    : 'http://localhost:4000';

const API_PREFIX =
  typeof process !== 'undefined' && process.env && process.env.API_PREFIX
    ? process.env.API_PREFIX
    : '/backend';

function joinUrl(base, prefix) {
  const b = String(base || '')
  const p = String(prefix || '')
  if (!p) return b
  if (!b) return p.startsWith('/') ? p : `/${p}`
  return `${b.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`
}

const API_BASE = joinUrl(API_ORIGIN, API_PREFIX)

export { API_BASE, API_PREFIX };

function normalizeHeaders(headers) {
  if (!headers) return {};
  // If it's a Headers instance, convert to a plain object
  try {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return Object.fromEntries(headers.entries());
    }
  } catch (e) {
    // ignore
  }
  return headers;
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;

  const userHeaders = normalizeHeaders(options.headers);
  const mergedHeaders = {
    // sensible defaults, allow override
    'Content-Type': 'application/json',
    ...(userHeaders || {}),
  };

  const resp = await fetch(url, {
    ...options,
    headers: mergedHeaders,
  });

  const contentType = resp.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await resp.json().catch(() => null) : null;

  if (!resp.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Request failed with status ${resp.status}`;
    const error = new Error(message);
    error.status = resp.status;
    error.data = data;
    throw error;
  }

  return data ?? {};
}

// Public API helpers

export async function generateQuestions({ num = 5, topic = 'general behavioral', stack } = {}) {
  return request('/generate-questions', {
    method: 'POST',
    body: JSON.stringify({ num, topic, stack }),
  });
}

export async function finalizeUpload({ sessionId, name, email, country, phone, interviewId }) {
  return request('/upload-complete', {
    method: 'POST',
    body: JSON.stringify({ sessionId, name, email, country, phone, interviewId }),
  });
}

export async function adminLogin(password) {
  return request('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function fetchRecordings(token) {
  return request('/admin/recordings', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function deleteRecording(id, token) {
  return request(`/admin/recordings/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

// Interview sessions (admin-managed)

export async function fetchInterview(interviewId) {
  return request(`/interviews/${encodeURIComponent(interviewId)}`, {
    // public endpoint
    headers: {},
  })
}

export async function fetchAdminInterviews(token) {
  return request('/admin/interviews', {
    headers: { Authorization: `Bearer ${token}` },
  })
}

export async function createAdminInterview({ stack, title }, token) {
  return request('/admin/interviews', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ stack, title }),
  })
}

export async function deleteAdminInterview(interviewId, token) {
  return request(`/admin/interviews/${encodeURIComponent(interviewId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export async function fetchStatus() {
  return request('/status', {
    headers: {},
  })
}


