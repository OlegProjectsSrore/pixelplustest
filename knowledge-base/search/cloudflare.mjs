// Обращения к Cloudflare REST API: эмбеддинги Workers AI (bge-m3) и индекс Vectorize.
// Токен берётся из переменной CLOUDFLARE_API_TOKEN, иначе из .env сайта портфолио (тот же аккаунт).
import fs from 'node:fs';

export const INDEX = 'pixelplus-services';
export const DIMENSIONS = 1024;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '6d05f3368fb4a17fd693106dc7cdac83';
const ENV_FILE = 'S:/PROJECTS/portfolio-site/.env';

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const match = fs.readFileSync(ENV_FILE, 'utf8').match(/CLOUDFLARE_API_TOKEN\s*=\s*"?([^"\r\n]+)/);
  if (!match) throw new Error(`Нет CLOUDFLARE_API_TOKEN ни в окружении, ни в ${ENV_FILE}`);
  return match[1].trim();
}

export async function api(apiPath, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/${apiPath}`, { ...init, headers: { Authorization: `Bearer ${token()}`, ...init.headers } });
    const data = await response.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${response.status}` }] }));
    if (data.success) return data.result;
    if (attempt >= 4) throw new Error(`${apiPath}: ${JSON.stringify(data.errors)}`);
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
}

export async function embed(texts) {
  const result = await api('ai/run/@cf/baai/bge-m3', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texts, truncate_inputs: true }) });
  return result.data;
}

export async function query(vector, topK, filter) {
  const result = await api(`vectorize/v2/indexes/${INDEX}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vector, topK, returnMetadata: 'none', ...(filter ? { filter } : {}) }) });
  return result.matches.map(m => m.id);
}
