export async function modUploadPayload(
  dll: File | Blob,
  thumb: File | null,
): Promise<{ headers: Record<string, string>; body: BodyInit }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  const dllBytes = new Uint8Array(await dll.arrayBuffer());
  if (!thumb) {
    return { headers, body: dllBytes };
  }
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
  const body = new Uint8Array(dllBytes.length + thumbBytes.length);
  body.set(dllBytes, 0);
  body.set(thumbBytes, dllBytes.length);
  headers['X-Thumbnail-Size'] = String(thumbBytes.length);
  return { headers, body };
}
