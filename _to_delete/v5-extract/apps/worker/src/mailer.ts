import { createTransport } from 'nodemailer';

export interface Mail { to: string; subject: string; text: string; html: string }
export interface Mailer { send(mail: Mail): Promise<{ messageId: string }> }

/** Real delivery over SMTP (Mailpit in development, any provider's SMTP relay in production). */
export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(url: string, private readonly from: string) { this.transport = createTransport(url); }
  async send(m: Mail): Promise<{ messageId: string }> {
    const r = await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    return { messageId: String(r.messageId) };
  }
}

/** Development fallback when no SMTP server is configured: logs the fact of the e-mail, never its body (it holds secrets). */
export class LogMailer implements Mailer {
  constructor(private readonly log: (msg: string, extra?: Record<string, unknown>) => void) {}
  async send(m: Mail): Promise<{ messageId: string }> {
    this.log('mail not sent (no SMTP_URL configured)', { subject: m.subject });
    return { messageId: `log-${Date.now()}` };
  }
}

/** Test double that records what would have been sent. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  failNext = 0;
  async send(m: Mail): Promise<{ messageId: string }> {
    if (this.failNext > 0) { this.failNext--; throw new Error('smtp unavailable'); }
    this.sent.push(m);
    return { messageId: `mem-${this.sent.length}` };
  }
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
