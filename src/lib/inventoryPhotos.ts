import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes
} from 'firebase/storage';
import { storage } from '../firebase';
import { InventoryPlant } from '../types';
import { updateInventoryPlant } from './inventory';

/** Compress an image file to a JPEG blob suitable for Storage upload. */
export async function fileToCompressedJpegBlob(
  file: File,
  maxEdge = 1280,
  quality = 0.82
): Promise<Blob> {
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
    if (!ctx) throw new Error('Could not process image.');
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not compress image.'))),
        'image/jpeg',
        quality
      );
    });
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function photoObjectPath(tenantId: string, plantId: string): string {
  return `tenants/${tenantId}/inventory/${plantId}/photo.jpg`;
}

export async function uploadInventoryPlantPhoto(params: {
  tenantId: string;
  plant: InventoryPlant;
  file: File;
}): Promise<InventoryPlant> {
  const path = photoObjectPath(params.tenantId, params.plant.id);
  const blob = await fileToCompressedJpegBlob(params.file);
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, {
    contentType: 'image/jpeg',
    cacheControl: 'public,max-age=31536000'
  });
  const photoUrl = await getDownloadURL(storageRef);
  const updated: InventoryPlant = {
    ...params.plant,
    photoUrl,
    photoPath: path,
    dateUpdated: new Date().toISOString()
  };
  await updateInventoryPlant(updated);
  return updated;
}

export async function removeInventoryPlantPhoto(plant: InventoryPlant): Promise<InventoryPlant> {
  if (plant.photoPath) {
    try {
      await deleteObject(ref(storage, plant.photoPath));
    } catch (err) {
      console.warn('Could not delete plant photo from storage:', err);
    }
  }
  const updated: InventoryPlant = {
    ...plant,
    photoUrl: null,
    photoPath: null,
    dateUpdated: new Date().toISOString()
  };
  await updateInventoryPlant(updated);
  return updated;
}

export function buildAvailabilityEmailHtml(params: {
  nurseryName: string;
  plants: InventoryPlant[];
  intro?: string;
}): string {
  const rows = params.plants
    .map((plant) => {
      const photoLink =
        plant.photoUrl && /^https?:\/\//i.test(plant.photoUrl)
          ? `<a href="${plant.photoUrl}" target="_blank" rel="noopener noreferrer" style="color:#0e7490;font-weight:700;text-decoration:underline;">View photo</a>`
          : `<span style="color:#94a3b8;">No photo</span>`;
      const price =
        plant.listPrice != null ? `$${plant.listPrice.toFixed(2)}` : '—';
      const category = plant.category
        ? `<div style="color:#64748b;font-size:11px;margin-top:2px;">${escapeHtml(plant.category)}</div>`
        : '';
      return `
        <tr>
          <td style="padding:12px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
            <div style="font-weight:800;color:#0f172a;">${escapeHtml(plant.plantName)}</div>
            ${category}
          </td>
          <td style="padding:12px 8px;border-bottom:1px solid #e2e8f0;text-align:center;color:#475569;font-family:monospace;">${escapeHtml(plant.containerSize || '')}</td>
          <td style="padding:12px 8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:700;color:#0f172a;font-family:monospace;">${plant.quantityAvailable}</td>
          <td style="padding:12px 8px;border-bottom:1px solid #e2e8f0;text-align:right;font-family:monospace;color:#0f172a;">${price}</td>
          <td style="padding:12px 8px;border-bottom:1px solid #e2e8f0;text-align:center;">${photoLink}</td>
        </tr>`;
    })
    .join('');

  const intro = params.intro?.trim()
    ? `<p style="margin:0 0 18px 0;color:#475569;font-size:14px;line-height:1.5;">${escapeHtml(params.intro.trim())}</p>`
    : `<p style="margin:0 0 18px 0;color:#475569;font-size:14px;line-height:1.5;">Here is our current availability. Click <strong>View photo</strong> to open a plant photo in your browser.</p>`;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,sans-serif;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e2e8f0;">
    <h1 style="margin:0 0 4px 0;font-size:22px;color:#0e7490;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(params.nurseryName)}</h1>
    <p style="margin:0 0 20px 0;font-size:12px;color:#64748b;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Current Availability</p>
    ${intro}
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="text-align:left;padding:10px 8px;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;">Plant</th>
          <th style="text-align:center;padding:10px 8px;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;">Size</th>
          <th style="text-align:center;padding:10px 8px;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;">Qty</th>
          <th style="text-align:right;padding:10px 8px;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;">Price</th>
          <th style="text-align:center;padding:10px 8px;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;">Photo</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <p style="margin:22px 0 0 0;font-size:12px;color:#94a3b8;">Sent via NurseryOS · Availability subject to change</p>
  </div>
</body>
</html>`;
}

export function buildAvailabilityEmailText(params: {
  nurseryName: string;
  plants: InventoryPlant[];
  intro?: string;
}): string {
  const lines = params.plants.map((plant) => {
    const price = plant.listPrice != null ? `$${plant.listPrice.toFixed(2)}` : '—';
    const photo = plant.photoUrl ? `Photo: ${plant.photoUrl}` : 'Photo: (none)';
    return `${plant.plantName} · ${plant.containerSize} · Qty ${plant.quantityAvailable} · ${price}\n${photo}`;
  });
  return [
    `${params.nurseryName} — Current Availability`,
    '',
    params.intro?.trim() || 'Here is our current availability.',
    '',
    ...lines,
    '',
    'Sent via NurseryOS'
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
