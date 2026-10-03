"""Parse mod DLL uploads with optional thumbnails (trailing bytes or legacy header)."""

import base64

from fastapi import HTTPException, Request

MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024


def detect_thumbnail(data: bytes) -> str | None:
    if not data or len(data) > MAX_THUMBNAIL_BYTES:
        return None
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def parse_thumbnail(request: Request, artifact: bytes) -> tuple[bytes, bytes | None, str | None]:
    """Return (dll_bytes, thumbnail_bytes, thumbnail_mime)."""
    size_header = request.headers.get("x-thumbnail-size", "").strip()
    if size_header.isdigit():
        thumb_size = int(size_header)
        if thumb_size <= 0:
            return artifact, None, None
        if thumb_size > MAX_THUMBNAIL_BYTES:
            raise HTTPException(422, "Thumbnail must be a JPEG, PNG, or WebP under 2 MB")
        if len(artifact) <= thumb_size:
            raise HTTPException(422, "Upload body is too small for the thumbnail suffix")
        raw = artifact[-thumb_size:]
        dll = artifact[:-thumb_size]
        mime = detect_thumbnail(raw)
        if not mime:
            raise HTTPException(422, "Thumbnail must be a JPEG, PNG, or WebP under 2 MB")
        return dll, raw, mime

    thumb_header = request.headers.get("x-thumbnail-base64", "").strip()
    if not thumb_header:
        return artifact, None, None
    try:
        raw = base64.b64decode(thumb_header, validate=True)
    except Exception as error:
        raise HTTPException(422, "Thumbnail must be valid base64 image data") from error
    mime = detect_thumbnail(raw)
    if not mime:
        raise HTTPException(422, "Thumbnail must be a JPEG, PNG, or WebP under 2 MB")
    return artifact, raw, mime
