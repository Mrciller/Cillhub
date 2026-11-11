// Outgoing mail over the SMTP server set in the instance settings (plain text only): password reset and the admin test mail
import nodemailer from 'nodemailer';
import { setting, mailConfigured, scrub } from './instance.js';

export { mailConfigured };

function transport() {
  const security = setting('smtp_security');
  const user = setting('smtp_user');
  return nodemailer.createTransport({
    host: setting('smtp_host'), port: setting('smtp_port'), secure: security === 'tls', requireTLS: security === 'starttls',
    ignoreTLS: security === 'none', auth: user ? { user, pass: setting('smtp_password') ?? '' } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
  });
}

// 7.11: who sends the mail, once the operator filled in a name (a Verein or company names itself on its correspondence)
function footer() {
  const name = setting('legal_operator')?.name;
  const url = setting('public_url') ?? process.env.CILLCORD_PUBLIC_URL;
  return name ? `\n-- \n${name}${url ? `\n${url.replace(/\/+$/, '')}/imprint` : ''}\n` : '';
}

export async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) throw new Error('Email is not set up on this instance.');
  return transport().sendMail({ from: setting('smtp_from'), to, subject, text: text + footer() });
}

// an SMTP error for the admin: its text, never the password
export const mailError = e => scrub(e?.message ?? String(e)).slice(0, 300);
