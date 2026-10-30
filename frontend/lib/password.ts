const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');

export async function requestPasswordChange(currentPassword: string, newPassword: string) {
  const token = localStorage.getItem('apexcare_token');
  const response = await fetch(`${API}/me/password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || 'Unable to change password.');
  return body.data;
}
