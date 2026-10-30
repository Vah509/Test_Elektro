// test-env-tg.mjs
import fs from 'node:fs';
import path from 'node:path';

// Полностью аналогично вашему scripts/lib/telegram.mjs
const TOKEN = process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
export const tgEnabled = !!(TOKEN && CHAT);

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', ...body });
  if (!res.ok) throw new Error(`Telegram ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 150).replace(TOKEN, '***')}`);
}

export async function tgSend(text) {
  if (!tgEnabled) { 
    console.log('[telegram отключён: нет TG_TOKEN/TG_CHAT_ID]\n' + text); 
    return; 
  }
  try {
    await call('sendMessage', { 
      headers: { 'content-type': 'application/json' }, 
      body: JSON.stringify({ chat_id: CHAT, text: String(text).slice(0, 4000), disable_web_page_preview: true }) 
    });
    console.log('✅ Тестовое сообщение успешно отправлено в Telegram!');
  } catch (e) { 
    console.error('❌ Ошибка отправки:', String(e.message || e)); 
  }
}

// Запускаем отправку теста
await tgSend('Привет ТЕСТ');
