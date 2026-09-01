import { authJsonHeaders } from './apiAuth';
import { fileToCompressedJpegBlob } from './inventoryPhotos';

function estimatePhotoPath(tenantId: string, lineId: string): string {
  return `tenants/${tenantId}/estimatePhotos/${lineId}/photo.jpg`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  });
}

/** Upload a photo for an estimate line (public HTTPS URL for customer PDF/email links). */
export async function uploadEstimateLinePhoto(params: {
  tenantId: string;
  lineId: string;
  file: File;
}): Promise<{ photoUrl: string; photoPath: string }> {
  const path = estimatePhotoPath(params.tenantId, params.lineId);
  const blob = await fileToCompressedJpegBlob(params.file);
  const imageBase64 = await blobToBase64(blob);
  const headers = await authJsonHeaders();
  const res = await fetch('/api/estimate-photo', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tenantId: params.tenantId,
      lineId: params.lineId,
      imageBase64
    })
  });
  const data = (await res.json().catch(() => ({}))) as {
    photoUrl?: string;
    photoPath?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || 'Could not upload estimate photo.');
  }
  if (!data.photoUrl) {
    throw new Error('Upload succeeded but no photo URL was returned.');
  }
  return { photoUrl: data.photoUrl, photoPath: data.photoPath || path };
}
