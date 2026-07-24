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

/**
 * Resize/compress a picked image file into a data URL suitable for storing on
 * the tenant doc (Firestore). Caps longest edge at `maxEdge` px.
 */
export async function fileToCompressedLogoDataUrl(
  file: File,
  maxEdge = 512
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (PNG, JPG, or WebP).');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image.'));
      el.src = objectUrl;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process logo image.');
    ctx.drawImage(img, 0, 0, width, height);
    // Prefer JPEG for smaller Firestore docs; keep PNG if source had transparency.
    const usePng = file.type === 'image/png';
    const dataUrl = usePng
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', 0.85);
    // Soft cap ~700KB encoded; Firestore docs max 1MB.
    if (dataUrl.length > 700_000) {
      throw new Error('Logo is too large after compression. Try a simpler image.');
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Fetch an image URL and return a data URL + jsPDF format for addImage. */
export async function imageSrcToDataUrl(
  src: string
): Promise<{ dataUrl: string; format: JsPdfImageFormat }> {
  if (src.startsWith('data:image/')) {
    if (src.startsWith('data:image/png')) return { dataUrl: src, format: 'PNG' };
    if (src.startsWith('data:image/webp')) return { dataUrl: src, format: 'WEBP' };
    return { dataUrl: src, format: 'JPEG' };
  }
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
