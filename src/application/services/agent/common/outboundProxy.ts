import type { Agent } from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, type Dispatcher } from 'undici';

/**
 * سرویس‌هایی که از ایران فیلترن (تلگرام، واتساپ، OpenAI) از پراکسی VPN می‌رن (wireproxy روی سرور)؛ بقیه مستقیم. اسم
 * دامنه رو خود پراکسی از داخل تونل پیدا می‌کنه، پس DNS آلوده‌ی شبکه جوابی براشون نمی‌ده.
 *   OUTBOUND_PROXY_URL   پراکسی HTTP (مثلاً http://wireproxy:8080) برای واتساپ و OpenAI
 *   OUTBOUND_SOCKS_URL   پراکسی SOCKS5 (مثلاً socks5://wireproxy:1080) برای مانیتورینگ تلگرام (MTProto فقط SOCKS می‌گیره)
 * خالی: همه مستقیم (سیستمی که خودش VPN داره).
 */
const proxyUrl = (): string | null => process.env.OUTBOUND_PROXY_URL?.trim() || null;

let agent: { url: string; value: Agent } | undefined;
let dispatcher: { url: string; value: Dispatcher } | undefined;

/** برای کلاینت‌های http/https (axios، وب‌سوکت و آپلودهای Baileys)؛ undefined یعنی مستقیم. */
export function outboundAgent(): Agent | undefined {
  const url = proxyUrl();
  if (!url) return undefined;
  if (agent?.url !== url) agent = { url, value: new HttpsProxyAgent(url, { keepAlive: true }) as unknown as Agent };
  return agent.value;
}

/** برای fetch خود Node (دانلود مدیای Baileys)؛ undefined یعنی مستقیم. */
export function outboundDispatcher(): Dispatcher | undefined {
  const url = proxyUrl();
  if (!url) return undefined;
  if (dispatcher?.url !== url) dispatcher = { url, value: new ProxyAgent(url) };
  return dispatcher.value;
}

/** تنظیمات axios برای سرویس فیلترشده: از پراکسی (پراکسی env خود axios خاموش)، یا هیچی. */
export function outboundAxios(): { httpsAgent?: Agent; httpAgent?: Agent; proxy?: false } {
  const value = outboundAgent();
  return value ? { httpsAgent: value, httpAgent: value, proxy: false } : {};
}

/** پراکسی GramJS از OUTBOUND_SOCKS_URL؛ undefined یعنی مستقیم. */
export function telegramSocksProxy(): { ip: string; port: number; socksType: 5; timeout: number } | undefined {
  const raw = process.env.OUTBOUND_SOCKS_URL?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  return { ip: url.hostname, port: Number(url.port) || 1080, socksType: 5, timeout: 10 };
}
