// Shared Hevy API helper.

const API = 'https://api.hevyapp.com/v1';

export const KG_TO_LBS = 2.20462;
export const LBS_TO_KG = 0.45359237;

export async function hevy(path: string, init?: RequestInit): Promise<any> {
  const key = process.env.HEVY_API_KEY;
  if (!key) throw new Error('HEVY_API_KEY is not set — see .env.example');
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'api-key': key, 'Content-Type': 'application/json', ...(init?.headers as any) },
  });
  if (!res.ok) {
    throw new Error(`Hevy ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
