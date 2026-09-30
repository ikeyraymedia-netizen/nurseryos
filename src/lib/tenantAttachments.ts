import { authJsonHeaders } from './apiAuth';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(blob);
  });
}

/** Upload a vendor invoice or customer BOL through the server; returns download URL + Storage path. */
export async function uploadTenantAttachment(params: {
  tenantId: string;
  kind: 'vendorBill' | 'customerBol';
  docId: string;
  blob: Blob;
  contentType: 'application/pdf' | 'image/jpeg';
}): Promise<{ url: string; path: string }> {
  const dataBase64 = await blobToBase64(params.blob);
  const headers = await authJsonHeaders();
  const res = await fetch('/api/tenant-attachment', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tenantId: params.tenantId,
      kind: params.kind,
      docId: params.docId,
      contentType: params.contentType,
      dataBase64
    })
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; path?: string; error?: string };
  if (!res.ok || !data.url || !data.path) {
    throw new Error(data.error || 'Could not upload file.');
  }
  return { url: data.url, path: data.path };
}
