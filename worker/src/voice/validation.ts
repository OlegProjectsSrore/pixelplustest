import { INTERVIEW_BUDGET_MS } from '../audit/contracts.ts';
export const ULTRAVOX_API_ORIGIN = 'https://api.ultravox.ai';
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function nonempty(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
export function callId(value: unknown): string {
  const id = nonempty(value, 'call ID', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid call ID');
  return id;
}
export function timestamp(value: unknown, name: string, nullable = false): number | null {
  if (nullable && value == null) return null;
  const text = nonempty(value, name, 64);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error(`Invalid ${name}`);
  const result = Date.parse(text);
  if (!Number.isFinite(result)) throw new Error(`Invalid ${name}`);
  return result;
}
export function nullableString(value: unknown, name: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`);
  return value;
}
export function remainingSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > INTERVIEW_BUDGET_MS / 1000) throw new Error(`Remaining interview time must be in (0, ${INTERVIEW_BUDGET_MS / 1000}] seconds`);
  // Never round upwards beyond the caller's remaining budget.
  const result = Math.floor(value * 1000) / 1000;
  if (result <= 0) throw new Error('No remaining interview time');
  return result;
}
