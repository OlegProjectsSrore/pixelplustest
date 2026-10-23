import type { ReportRecord } from "../storage/types.ts";
import { sha256, withTimeout } from "./pdf.ts";

export interface ReportKv {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer, options: { expiration: number }): Promise<void>;
}
export interface ReportReadStore {
  findReportByTokenHash(hash: string, now: number): Promise<ReportRecord | null>;
  lookupReportToken(hash: string): Promise<ReportRecord | null>;
}

function statusResponse(status: string, code: number, retryAfter?: number): Response {
  return Response.json({ status, ...(retryAfter ? { retry_after_seconds: retryAfter } : {}) }, {
    status: code, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
  });
}

/** This path only reads D1/KV. A cache miss never creates or retries a render job. */
export async function getReportResponse(store: ReportReadStore, kv: ReportKv, token: string, now = Date.now()): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return statusResponse("not_found", 404);
  const tokenHash = await sha256(token);
  const report = await store.findReportByTokenHash(tokenHash, now);
  if (!report) return await store.lookupReportToken(tokenHash) ? statusResponse("expired", 410) : statusResponse("not_found", 404);
  if (report.reportExpiresAt !== null && now >= report.reportExpiresAt) return statusResponse("expired", 410);
  if (report.status === "failed") return statusResponse("failed", 503);
  if (report.status !== "ready" || !report.kvKey) return statusResponse(report.status, 202, 10);
  try {
    const pdf = await withTimeout(kv.get(report.kvKey, "arrayBuffer"), 5000, "KV_READ_TIMEOUT");
    if (!pdf) return statusResponse("temporarily_unavailable", 202, 60);
    if (report.pdfHash && await sha256(pdf) !== report.pdfHash) return statusResponse("temporarily_unavailable", 503, 60);
    return new Response(pdf, { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="preliminary-audit.pdf"',
      "Content-Length": String(pdf.byteLength), "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    } });
  } catch { return statusResponse("temporarily_unavailable", 503, 60); }
}
