import { auth } from '../firebase';

export type PublicAvailabilitySettings = {
  enabled: boolean;
  slug: string;
  showQty: boolean;
  showPhotos: boolean;
  inStockOnly: boolean;
};

export function suggestPublicAvailabilitySlug(nurseryName: string): string {
  return (
    nurseryName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'nursery'
  );
}

export function publicAvailabilityPageUrl(slug: string, origin = window.location.origin): string {
  return `${origin.replace(/\/$/, '')}/a/${slug}`;
}

export function publicAvailabilityApiUrl(slug: string, origin = window.location.origin): string {
  return `${origin.replace(/\/$/, '')}/api/public/availability/${slug}`;
}

async function authHeaders(): Promise<HeadersInit> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

export async function savePublicAvailabilitySettings(params: {
  tenantId: string;
} & PublicAvailabilitySettings): Promise<{
  ok: boolean;
  enabled: boolean;
  slug: string | null;
  showQty: boolean;
  showPhotos: boolean;
  inStockOnly: boolean;
  publicPath: string | null;
  publicApiPath: string | null;
}> {
  const res = await fetch('/api/public/availability/settings', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(body.error || 'Could not save public availability settings.'));
  }
  return body as {
    ok: boolean;
    enabled: boolean;
    slug: string | null;
    showQty: boolean;
    showPhotos: boolean;
    inStockOnly: boolean;
    publicPath: string | null;
    publicApiPath: string | null;
  };
}
