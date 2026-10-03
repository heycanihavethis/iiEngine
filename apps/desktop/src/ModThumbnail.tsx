import { useEffect, useState } from 'react';
import { apiRequest } from './api';

export function ModThumbnail({
  path,
  name,
  className = '',
}: {
  path?: string | null;
  name: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    if (!path) {
      setSrc(null);
      return;
    }
    void apiRequest(path)
      .then(async (response) => {
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (src) {
    return (
      <div className={`mod-thumb-frame ${className}`}>
        <img src={src} alt="" />
      </div>
    );
  }

  return (
    <div className={`mod-thumb-frame mod-thumb-fallback ${className}`} aria-hidden>
      <span>{name}</span>
    </div>
  );
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
