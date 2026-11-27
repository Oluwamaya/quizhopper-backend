import { env } from '../config/env';

export const isEmailConfigured = (): boolean => {
  return Boolean(env.ZEPTO_MAIL_API_KEY && env.ZEPTO_MAIL_FROM_EMAIL);
};

const escapeHtml = (value: string): string =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatZeptoAuthHeader = (rawKey: string): string => {
  const trimmed = rawKey.trim();
  if (/^Zoho-enczapikey\s+/i.test(trimmed)) {
    return trimmed;
  }
  return `Zoho-enczapikey ${trimmed}`;
};

const wrapEmailLayout = (title: string, bodyHtml: string): string => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#0c081e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0c081e;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#16102b;border:1px solid #2d2350;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:24px 28px;background:linear-gradient(135deg,#0070f3 0%,#7928ca 100%);text-align:center;">
              <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">Quiz Hopper</h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.88);">${escapeHtml(title)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-size:15px;line-height:1.6;color:#e2e8f0;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px;border-top:1px solid #261e44;text-align:center;font-size:12px;color:#718096;">
              Quiz Hopper &bull; A product of Mayacode Technologies<br/>
              If you did not expect this email, you can safely ignore it.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

export interface SendEmailInput {
  to: string;
  toName?: string;
  subject: string;
  html: string;
}

export const sendEmail = async ({ to, toName, subject, html }: SendEmailInput): Promise<{ sent: boolean; error?: string }> => {
  if (!to || !to.includes('@')) {
    return { sent: false, error: 'Invalid recipient email' };
  }

  if (!isEmailConfigured()) {
    console.warn(`[ZeptoMail] API key not configured — skipping live send to ${to} (Subject: "${subject}")`);
    return { sent: false, error: 'Email service not configured' };
  }

  try {
    const response = await fetch(env.ZEPTO_MAIL_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: formatZeptoAuthHeader(env.ZEPTO_MAIL_API_KEY)
      },
      body: JSON.stringify({
        from: {
          address: env.ZEPTO_MAIL_FROM_EMAIL,
          name: env.ZEPTO_MAIL_FROM_NAME
        },
        to: [
          {
            email_address: {
              address: to,
              name: toName || to.split('@')[0]
            }
          }
        ],
        subject,
        htmlbody: html
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[ZeptoMail] Failed (${response.status}) sending to ${to}:`, errBody);
      return { sent: false, error: `ZeptoMail error ${response.status}` };
    }

    return { sent: true };
  } catch (err: any) {
    console.error(`[ZeptoMail] Network error sending to ${to}:`, err?.message || err);
    return { sent: false, error: err?.message || 'Network error' };
  }
};

export const sendPasswordResetEmail = async (params: {
  to: string;
  name: string;
  resetLink: string;
  code: string;
  isGoogleSetup?: boolean;
}) => {
  const heading = params.isGoogleSetup
    ? 'Set Your Quiz Hopper Password'
    : 'Reset Your Quiz Hopper Password';

  const intro = params.isGoogleSetup
    ? `Hi ${escapeHtml(params.name)}, you requested to set an email &amp; password for your Quiz Hopper account. Your Google sign-in will continue to work alongside your new password.`
    : `Hi ${escapeHtml(params.name)}, we received a request to reset your Quiz Hopper password.`;

  const bodyHtml = `
    <p style="margin:0 0 16px;">${intro}</p>
    <p style="margin:0 0 12px;font-weight:700;color:#ffffff;">Option 1 — Enter this 6-digit verification code:</p>
    <div style="margin:0 0 22px;padding:16px;background:#0e0920;border:1.5px solid #4c3a8a;border-radius:12px;text-align:center;font-size:30px;font-weight:900;letter-spacing:8px;color:#fbd38d;">
      ${escapeHtml(params.code)}
    </div>
    <p style="margin:0 0 14px;font-weight:700;color:#ffffff;">Option 2 — Click the verification link:</p>
    <div style="text-align:center;margin:0 0 22px;">
      <a href="${escapeHtml(params.resetLink)}" style="display:inline-block;padding:13px 26px;background:linear-gradient(135deg,#0070f3 0%,#7928ca 100%);color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;">
        ${params.isGoogleSetup ? 'Set My Password' : 'Reset My Password'}
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#a0aec0;">
      This code and link expire in <strong>15 minutes</strong> and can only be used once. If you did not request this, ignore this email — your account remains secure.
    </p>`;

  return sendEmail({
    to: params.to,
    toName: params.name,
    subject: `${heading} — Code: ${params.code}`,
    html: wrapEmailLayout(heading, bodyHtml)
  });
};

export const sendPasswordChangedEmail = async (params: { to: string; name: string }) => {
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${escapeHtml(params.name)},</p>
    <p style="margin:0 0 14px;">Your Quiz Hopper password was just updated. For your security, any previous active sessions on other devices have been signed out.</p>
    <p style="margin:0;font-size:13px;color:#feb2b2;">If you did not make this change, reset your password immediately or contact Quiz Hopper support.</p>`;

  return sendEmail({
    to: params.to,
    toName: params.name,
    subject: 'Security Alert: Your Quiz Hopper password was updated',
    html: wrapEmailLayout('Account Security Notice', bodyHtml)
  });
};

export const sendJackpotWinnerEmail = async (params: {
  to: string;
  name: string;
  rank: number;
  roomTitle: string;
  prizeLabel: string;
  score: number;
  totalAnswerTimeMs: number;
}) => {
  const timeSec = ((params.totalAnswerTimeMs || 0) / 1000).toFixed(2);
  const bodyHtml = `
    <p style="margin:0 0 14px;">Congratulations, <strong>${escapeHtml(params.name)}</strong>! 🏆</p>
    <p style="margin:0 0 18px;">You finished in the <strong>Top 5</strong> of the Quiz Hopper Jackpot Room!</p>
    <div style="background:#0e0920;border:1.5px solid #d69e2e;border-radius:12px;padding:18px;margin:0 0 18px;">
      <p style="margin:0 0 8px;"><strong style="color:#fbd38d;">Room:</strong> ${escapeHtml(params.roomTitle)}</p>
      <p style="margin:0 0 8px;"><strong style="color:#fbd38d;">Jackpot Prize:</strong> ${escapeHtml(params.prizeLabel)}</p>
      <p style="margin:0 0 8px;"><strong style="color:#fbd38d;">Your Final Rank:</strong> #${params.rank}</p>
      <p style="margin:0 0 8px;"><strong style="color:#fbd38d;">Score:</strong> ${params.score} pts</p>
      <p style="margin:0;"><strong style="color:#fbd38d;">Total Answer Time:</strong> ${timeSec}s</p>
    </div>
    <p style="margin:0;font-size:14px;color:#cbd5e0;">
      Prizes are paid manually by the Quiz Hopper Admin outside the app. Keep an eye on your email and phone — our admin team will reach out shortly using your profile contact details!
    </p>`;

  return sendEmail({
    to: params.to,
    toName: params.name,
    subject: `🏆 You Won #${params.rank} in "${params.roomTitle}" (${params.prizeLabel})!`,
    html: wrapEmailLayout('Jackpot Winner Notification', bodyHtml)
  });
};

export const sendJackpotRefundEmail = async (params: {
  to: string;
  name: string;
  roomTitle: string;
  coinsRefunded: number;
  reason: string;
}) => {
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${escapeHtml(params.name)},</p>
    <p style="margin:0 0 16px;">Your entry coins for the Jackpot Room <strong>"${escapeHtml(params.roomTitle)}"</strong> have been automatically refunded to your Quiz Hopper wallet.</p>
    <div style="background:#0e0920;border:1px solid #38a169;border-radius:12px;padding:16px;margin:0 0 16px;">
      <p style="margin:0 0 6px;"><strong style="color:#68d391;">Refunded:</strong> +${params.coinsRefunded} Coins</p>
      <p style="margin:0;"><strong style="color:#68d391;">Reason:</strong> ${escapeHtml(params.reason)}</p>
    </div>
    <p style="margin:0;font-size:13px;color:#a0aec0;">Your updated coin balance is already live in your dashboard.</p>`;

  return sendEmail({
    to: params.to,
    toName: params.name,
    subject: `Refund Processed: +${params.coinsRefunded} Coins from "${params.roomTitle}"`,
    html: wrapEmailLayout('Jackpot Coin Refund', bodyHtml)
  });
};

export const sendJackpotEntryEmail = async (params: {
  to: string;
  name: string;
  roomTitle: string;
  prizeLabel: string;
  coinsPaid: number;
}) => {
  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${escapeHtml(params.name)},</p>
    <p style="margin:0 0 16px;">Your seat is confirmed for the live Jackpot Room!</p>
    <div style="background:#0e0920;border:1px solid #4c3a8a;border-radius:12px;padding:16px;margin:0 0 16px;">
      <p style="margin:0 0 6px;"><strong style="color:#fbd38d;">Room:</strong> ${escapeHtml(params.roomTitle)}</p>
      <p style="margin:0 0 6px;"><strong style="color:#fbd38d;">Jackpot Prize:</strong> ${escapeHtml(params.prizeLabel)}</p>
      <p style="margin:0;"><strong style="color:#fbd38d;">Entry Deducted:</strong> ${params.coinsPaid} Coins</p>
    </div>
    <p style="margin:0;font-size:13px;color:#a0aec0;">Good luck! Remember: if the room is cancelled or does not start, your entry coins are refunded automatically.</p>`;

  return sendEmail({
    to: params.to,
    toName: params.name,
    subject: `Seat Confirmed: "${params.roomTitle}" (${params.prizeLabel})`,
    html: wrapEmailLayout('Jackpot Room Entry Confirmed', bodyHtml)
  });
};
