/** Browser Run's documented PDF Quick Action; no browser navigation to user URLs. */
export interface PdfBrowser {
  quickAction(action: "pdf", options: {
    html: string;
    gotoOptions: { timeout: number; waitUntil: "load" };
    actionTimeout: number;
    pdfOptions: { timeout: number; preferCSSPageSize: boolean; printBackground: boolean };
    cacheTTL: number;
  }): Promise<Response>;
}

export class ReportFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  constructor(code: string, retryable = true, retryAfterMs = 60_000) {
    super(code);
    this.code = code; this.retryable = retryable; this.retryAfterMs = retryAfterMs;
    this.name = "ReportFailure";
  }
}

export async function withTimeout<T>(work: Promise<T>, milliseconds: number, code = "PROVIDER_TIMEOUT"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReportFailure(code)), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function renderPdf(browser: PdfBrowser, html: string, maxBytes = 8 * 1024 * 1024, timeoutMs = 18_000): Promise<ArrayBuffer> {
  // A timed-out Quick Action may still finish remotely. Its result is never published.
  return withTimeout((async () => {
    const response = await browser.quickAction("pdf", {
      html, gotoOptions: { timeout: 5000, waitUntil: "load" }, actionTimeout: 10_000,
      pdfOptions: { timeout: 10_000, preferCSSPageSize: true, printBackground: true }, cacheTTL: 0,
    });
    if (response.status === 429 || response.status === 503) {
      const seconds = Number(response.headers.get("Retry-After"));
      throw new ReportFailure("PDF_PROVIDER_BUSY", true, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 60_000);
    }
    if (!response.ok) throw new ReportFailure("PDF_PROVIDER_ERROR", response.status >= 500);
    if (response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") {
      throw new ReportFailure("PDF_INVALID_CONTENT_TYPE", false);
    }
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (declaredLength > maxBytes) throw new ReportFailure("PDF_TOO_LARGE", false);
    if (!response.body) throw new ReportFailure("PDF_EMPTY", false);
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maxBytes) throw new ReportFailure("PDF_TOO_LARGE", false);
        parts.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.byteLength; }
    if (new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-") throw new ReportFailure("PDF_INVALID_SIGNATURE", false);
    return data.buffer;
  })(), timeoutMs, "PDF_TIMEOUT");
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomReadToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
