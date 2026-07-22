import type { Tenant } from '../types';
import bayouLogoJpg from '../assets/images/bayou_state_logo_1783436759755.jpg';

/**
 * Built-in logos for known nurseries (used until a tenant sets logoUrl).
 * Keyed by a lowercase substring of the nursery name.
 */
const KNOWN_TENANT_LOGOS: Array<{ match: string; src: string }> = [
  { match: 'bayou', src: bayouLogoJpg }
];

type TenantLogoSource = Pick<Tenant, 'name' | 'logoUrl'> | string | null | undefined;

/** Resolve the logo image URL for a nursery (explicit logoUrl wins). */
export function resolveNurseryLogoSrc(tenant: TenantLogoSource): string | null {
  if (tenant == null) return null;
  if (typeof tenant === 'string') {
    const name = tenant.toLowerCase();
    return KNOWN_TENANT_LOGOS.find((entry) => name.includes(entry.match))?.src ?? null;
  }
  const explicit = tenant.logoUrl?.trim();
  if (explicit) return explicit;
  const name = (tenant.name || '').toLowerCase();
  return KNOWN_TENANT_LOGOS.find((entry) => name.includes(entry.match))?.src ?? null;
}

export type JsPdfImageFormat = 'JPEG' | 'PNG' | 'WEBP';

/** Fetch an image URL and return a data URL + jsPDF format for addImage. */
export async function imageSrcToDataUrl(
  src: string
): Promise<{ dataUrl: string; format: JsPdfImageFormat }> {
  const res = await fetch(src);
  if (!res.ok) {
    throw new Error(`Could not load logo image (${res.status}).`);
  }
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read logo image.'));
    reader.readAsDataURL(blob);
  });

  if (dataUrl.startsWith('data:image/png')) return { dataUrl, format: 'PNG' };
  if (dataUrl.startsWith('data:image/webp')) return { dataUrl, format: 'WEBP' };
  return { dataUrl, format: 'JPEG' };
}
