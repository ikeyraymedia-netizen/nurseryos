import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '../firebase';
import { fileToCompressedJpegBlob } from './inventoryPhotos';

const MAX_BYTES = 12 * 1024 * 1024;

function bolObjectPath(tenantId: string, orderId: string, ext: 'jpg' | 'pdf'): string {
  return `tenants/${tenantId}/customerBols/${orderId}/bol.${ext}`;
}

function isPdfFile(file: File): boolean {
  return (
    file.type === 'application/pdf' ||
    file.type === 'application/x-pdf' ||
    /\.pdf$/i.test(file.name)
  );
}

/** Upload a customer-provided BOL (image or PDF); returns Storage URL + path. */
export async function uploadCustomerBolAttachment(params: {
  tenantId: string;
  orderId: string;
  file: File;
}): Promise<{
  customerBolUrl: string;
  customerBolPath: string;
  customerBolFileName: string;
  customerBolContentType: string;
  customerBolUploadedAt: string;
}> {
  if (params.file.size > MAX_BYTES) {
    throw new Error('BOL file must be 12 MB or smaller.');
  }

  const uploadedAt = new Date().toISOString();
  const fileName = params.file.name.trim() || (isPdfFile(params.file) ? 'bol.pdf' : 'bol.jpg');

  if (isPdfFile(params.file)) {
    const path = bolObjectPath(params.tenantId, params.orderId, 'pdf');
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, params.file, {
      contentType: 'application/pdf',
      cacheControl: 'private,max-age=31536000'
    });
    return {
      customerBolUrl: await getDownloadURL(storageRef),
      customerBolPath: path,
      customerBolFileName: fileName,
      customerBolContentType: 'application/pdf',
      customerBolUploadedAt: uploadedAt
    };
  }

  if (!params.file.type.startsWith('image/') && !/\.(jpe?g|png|webp)$/i.test(params.file.name)) {
    throw new Error('BOL attachment must be an image or PDF.');
  }

  const blob = await fileToCompressedJpegBlob(params.file);
  const path = bolObjectPath(params.tenantId, params.orderId, 'jpg');
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, {
    contentType: 'image/jpeg',
    cacheControl: 'private,max-age=31536000'
  });
  return {
    customerBolUrl: await getDownloadURL(storageRef),
    customerBolPath: path,
    customerBolFileName: fileName.replace(/\.[^.]+$/, '') + '.jpg',
    customerBolContentType: 'image/jpeg',
    customerBolUploadedAt: uploadedAt
  };
}

/** Best-effort delete of a stored customer BOL file. */
export async function deleteCustomerBolAttachment(path: string | null | undefined): Promise<void> {
  const trimmed = String(path || '').trim();
  if (!trimmed) return;
  try {
    await deleteObject(ref(storage, trimmed));
  } catch {
    /* ignore missing / permission — order fields are cleared separately */
  }
}
