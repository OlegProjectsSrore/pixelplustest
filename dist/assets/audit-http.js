/** Transport only. State, revisions and expenditure are owned by the server. */
export class AuditRequestError extends Error {
  constructor(message, { code = 'network_error', status = 0, retryable = true, retryAfter = null } = {}) {
    super(message);
    this.name = 'AuditRequestError';
    Object.assign(this, { code, status, retryable, retryAfter });
  }
}

export function createAuditTransport(baseUrl, { fetcher = fetch, timeoutMs = 30000 } = {}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new AuditRequestError('Некорректный адрес сервиса аудита.', { code: 'configuration_required', retryable: false });
  }

  async function request(path, { method = 'GET', token, body, signal, pdf = false } = {}) {
    const target = new URL(path, base);
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/')) {
      throw new AuditRequestError('Недопустимый адрес запроса.', { code: 'invalid_request', retryable: false });
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: pdf ? 'application/pdf, application/json' : 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetcher(target.href, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
      });
      const contentType = response.headers.get('content-type') || '';
      if (response.ok && pdf && /^application\/pdf(?:;|$)/i.test(contentType)) return await response.blob();
      let data;
      try { data = await response.json(); }
      catch {
        throw new AuditRequestError('Сервис вернул неполный ответ. Сохранённый запрос можно повторить.', {
          code: 'invalid_response', status: response.status, retryable: true,
        });
      }
      if (!response.ok || data?.error || data?.ok === false) {
        const error = data?.error || {};
        const code = typeof error.code === 'string' ? error.code
          : pdf && typeof data?.status === 'string' ? data.status : 'request_failed';
        // Provider bodies are never exposed verbatim in the interface.
        const message = typeof error.message === 'string' && error.message.length <= 500
          ? error.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new AuditRequestError(message, { code, status: response.status,
          retryable: error.retryable === true || response.status === 429 || response.status >= 500,
          retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new AuditRequestError('Получен некорректный ответ сервиса.', { code: 'invalid_response' });
      }
      return data;
    } catch (error) {
      if (error instanceof AuditRequestError) throw error;
      throw new AuditRequestError(controller.signal.aborted
        ? 'Сервис не успел ответить. Ваш запрос сохранён для повторной отправки.'
        : 'Соединение потеряно. Ваш запрос сохранён для повторной отправки.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return { request };
}

/** Keep the exact pending request, including its operation ID, across reloads. */
export function createAuditStorage(storage, key = 'pixelplus.audit.v1') {
  function load() {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      return record && record.version === 1 && typeof record === 'object' && !Array.isArray(record) ? record : null;
    } catch { return null; }
  }
  function save(record) {
    try { storage.setItem(key, JSON.stringify({ ...record, version: 1 })); }
    catch {
      throw new AuditRequestError('Браузер не разрешает сохранить сессию. Разрешите хранение данных сайта, чтобы продолжить.', {
        code: 'storage_unavailable', retryable: false,
      });
    }
  }
  return { load, save, clear() { storage.removeItem(key); } };
}
