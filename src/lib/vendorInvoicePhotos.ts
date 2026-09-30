import { fileToCompressedJpegBlob } from './inventoryPhotos';
import { uploadTenantAttachment } from './tenantAttachments';

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

  if (!isPdf && !params.file.type.startsWith('image/') && !/\.(jpe?g|png|webp)$/i.test(params.file.name)) {
    throw new Error('Invoice attachment must be an image or PDF.');
  }

  const { url, path } = await uploadTenantAttachment({
    tenantId: params.tenantId,
    kind: 'vendorBill',
    docId: params.billId,
    blob: isPdf ? params.file : await fileToCompressedJpegBlob(params.file),
    contentType: isPdf ? 'application/pdf' : 'image/jpeg'
  });
  return { invoicePhotoUrl: url, invoicePhotoPath: path };
}
