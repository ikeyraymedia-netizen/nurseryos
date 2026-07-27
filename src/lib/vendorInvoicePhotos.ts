import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '../firebase';
import { fileToCompressedJpegBlob } from './inventoryPhotos';

function invoiceObjectPath(tenantId: string, billId: string, ext: 'jpg' | 'pdf'): string {
  return `tenants/${tenantId}/vendorBills/${billId}/invoice.${ext}`;
}

/** Upload a scanned vendor invoice image or PDF; returns Storage URL + path. */
export async function uploadVendorInvoiceAttachment(params: {
  tenantId: string;
  billId: string;
  file: File;
}): Promise<{ invoicePhotoUrl: string; invoicePhotoPath: string }> {
  const isPdf =
    params.file.type === 'application/pdf' ||
    params.file.type === 'application/x-pdf' ||
    /\.pdf$/i.test(params.file.name);

  if (isPdf) {
    const path = invoiceObjectPath(params.tenantId, params.billId, 'pdf');
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, params.file, {
      contentType: 'application/pdf',
      cacheControl: 'private,max-age=31536000'
    });
    return {
      invoicePhotoUrl: await getDownloadURL(storageRef),
      invoicePhotoPath: path
    };
  }

  if (!params.file.type.startsWith('image/') && !/\.(jpe?g|png|webp)$/i.test(params.file.name)) {
    throw new Error('Invoice attachment must be an image or PDF.');
  }

  const blob = await fileToCompressedJpegBlob(params.file);
  const path = invoiceObjectPath(params.tenantId, params.billId, 'jpg');
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, {
    contentType: 'image/jpeg',
    cacheControl: 'private,max-age=31536000'
  });
  return {
    invoicePhotoUrl: await getDownloadURL(storageRef),
    invoicePhotoPath: path
  };
}
