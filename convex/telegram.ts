// Telegram 推送（仅通知，不做交易判断）。

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

export async function sendTelegram(text: string): Promise<string | null> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; skipping push");
    return "skipped";
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`telegram http error ${res.status}: ${body}`);
      return `http ${res.status}`;
    }
    return null;
  } catch (e) {
    console.error(`telegram fetch failed: ${String(e)}`);
    return `exception: ${String(e)}`.slice(0, 160);
  }
}
