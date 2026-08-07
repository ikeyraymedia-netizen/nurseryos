import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '../firebase';
import { fileToCompressedJpegBlob } from './inventoryPhotos';

function estimatePhotoPath(tenantId: string, lineId: string): string {
  return `tenants/${tenantId}/estimatePhotos/${lineId}/photo.jpg`;
}

/** Upload a photo for an estimate line (public HTTPS URL for customer PDF/email links). */
export async function uploadEstimateLinePhoto(params: {
  tenantId: string;
  lineId: string;
  file: File;
}): Promise<{ photoUrl: string; photoPath: string }> {
  const path = estimatePhotoPath(params.tenantId, params.lineId);
  const blob = await fileToCompressedJpegBlob(params.file);
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, {
    contentType: 'image/jpeg',
    cacheControl: 'public,max-age=31536000'
  });
  const photoUrl = await getDownloadURL(storageRef);
  return { photoUrl, photoPath: path };
}
