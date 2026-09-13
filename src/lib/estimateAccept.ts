import { authJsonHeaders } from './apiAuth';

export async function prepareEstimateAcceptLink(params: {
  tenantId: string;
  documentId: string;
}): Promise<{ acceptUrl: string; acceptanceStatus: string }> {
  const res = await fetch('/api/estimates/prepare-accept', {
    method: 'POST',
    headers: await authJsonHeaders(),
    body: JSON.stringify({
      ...params,
      origin: typeof window !== 'undefined' ? window.location.origin : undefined
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      String((data as { error?: string }).error || 'Could not prepare accept link.')
    );
  }
  return {
    acceptUrl: String((data as { acceptUrl?: string }).acceptUrl || ''),
    acceptanceStatus: String((data as { acceptanceStatus?: string }).acceptanceStatus || 'pending')
  };
}

export function readEstimateAcceptTokenFromPath(
  pathname = window.location.pathname
): string | null {
  const match = pathname.match(/^\/e\/accept\/([A-Za-z0-9_-]{16,128})$/);
  return match?.[1] || null;
}
