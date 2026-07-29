export async function submitAccessRequest(input: {
  displayName: string;
  nurseryName: string;
  email: string;
  message?: string;
  locale?: string;
}): Promise<void> {
  const res = await fetch('/api/request-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: input.displayName.trim(),
      nurseryName: input.nurseryName.trim(),
      email: input.email.trim(),
      message: input.message?.trim() || '',
      locale: input.locale || ''
    })
  });

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    success?: boolean;
  };

  if (!res.ok || data.success === false) {
    throw new Error(data.error || 'Could not send your access request. Please try again.');
  }
}
