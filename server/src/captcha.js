// reCAPTCHA v2 (checkbox) at sign-up and password reset, on when the admin set both keys
import { HttpError } from './errors.js';
import { setting, captchaOn } from './instance.js';

export { captchaOn };

// tests only: points at a local stub; the default is Google's endpoint
const VERIFY_URL = process.env.CAPTCHA_VERIFY_URL || 'https://www.google.com/recaptcha/api/siteverify';

// true only on an explicit success; a timeout or a broken answer throws
export async function verifyCaptcha(token, ip) {
  const form = new URLSearchParams({ secret: setting('captcha_secret'), response: token, ...(ip && { remoteip: ip }) });
  const r = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`captcha verify answered HTTP ${r.status}`);
  return (await r.json())?.success === true;
}

const captchaError = code => {
  const e = new HttpError(400, 0, 'Complete the captcha.');
  e.body = { message: 'Complete the captcha.', captcha_key: [code], captcha_sitekey: setting('captcha_site_key'), captcha_service: 'recaptcha' };
  return e;
};

// open routes (register, forgot) call this before any other work; fails closed when Google cannot be reached
export async function requireCaptcha(ctx) {
  if (!captchaOn()) return;
  const token = ctx.body?.captcha_key;
  if (typeof token !== 'string' || !token || token.length > 4000) throw captchaError('captcha-required');
  let ok;
  try { ok = await verifyCaptcha(token, ctx.ip); } catch (e) {
    console.error(`captcha check failed: ${e.message}`);
    throw new HttpError(400, 0, 'The captcha check is unavailable right now. Try again in a minute.');
  }
  if (!ok) throw captchaError('invalid-response');
}
