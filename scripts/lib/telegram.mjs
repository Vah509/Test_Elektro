// Отправка в Telegram (без зависимостей). Токен и чат — из секретов репозитория.
// Имена переменных: TG_TOKEN + TG_CHAT_ID (допустимы также TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
export const tgEnabled = !!(TOKEN && CHAT);

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', ...body });
  if (!res.ok) throw new Error(`Telegram ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 150).replace(TOKEN, '***')}`);
}

export async function tgSend(text) {
  if (!tgEnabled) { console.log('[telegram отключён: нет TG_TOKEN/TG_CHAT_ID]\n' + text); return; }
  try {
    await call('sendMessage', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: String(text).slice(0, 4000), disable_web_page_preview: true }) });
  } catch (e) { console.error(String(e.message || e)); }
}

export async function tgDoc(file, caption = '') {
  if (!tgEnabled || !fs.existsSync(file)) return;
  try {
    const fd = new FormData();
    fd.append('chat_id', CHAT);
    if (caption) fd.append('caption', caption.slice(0, 1000));
    fd.append('document', new Blob([fs.readFileSync(file)]), path.basename(file));
    await call('sendDocument', { body: fd });
  } catch (e) { console.error(String(e.message || e)); }
}
