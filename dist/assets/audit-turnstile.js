let loading;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timer = setTimeout(() => { script.remove(); reject(new Error('Проверка доступа недоступна. Повторите позже.')); }, 20000);
    script.onload = () => { clearTimeout(timer); window.turnstile ? resolve(window.turnstile) : reject(new Error('Не удалось загрузить проверку доступа.')); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Не удалось загрузить проверку доступа.')); };
    document.head.append(script);
  }).catch(error => { loading = null; throw error; });
  return loading;
}

/** A new widget/token is requested for each server operation that requires Turnstile. */
export async function getTurnstileToken(container, sitekey, action) {
  if (!sitekey) throw new Error('Запуск аудита пока недоступен.');
  const turnstile = await loadTurnstile();
  return new Promise((resolve, reject) => {
    let widgetId;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Время проверки доступа истекло. Повторите проверку.')), 120000);
    function finish(error, token) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (widgetId !== undefined) turnstile.remove(widgetId);
      error ? reject(error) : resolve(token);
    }
    try {
      widgetId = turnstile.render(container, {
        sitekey, action, language: 'ru', size: 'compact',
        callback: token => finish(null, token),
        'error-callback': () => finish(new Error('Проверка доступа не пройдена. Повторите попытку.')),
        'expired-callback': () => finish(new Error('Проверка доступа устарела. Повторите попытку.')),
      });
      if (settled) turnstile.remove(widgetId);
    } catch { finish(new Error('Не удалось начать проверку доступа.')); }
  });
}
