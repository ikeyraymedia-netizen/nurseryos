/**
 * Security notices reuse the existing Resend account when it is configured.
 * If it is not, callers still write the audit log and an in-app alert.
 * This does not add a new email vendor.
 */
export async function sendSecurityNotice(
  to: string,
  subject: string,
  text: string
): Promise<'sent' | 'skipped'> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const email = to.trim().toLowerCase();
  if (!apiKey || !email) return 'skipped';

  const from = process.env.RESEND_FROM_EMAIL?.trim() || 'NurseryOS <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject,
        text
      })
    });
    if (!res.ok) {
      console.error('[security] notice email failed', res.status);
      return 'skipped';
    }
    return 'sent';
  } catch (err) {
    console.error(
      '[security] notice email failed',
      err instanceof Error ? err.message : 'request failed'
    );
    return 'skipped';
  }
}
