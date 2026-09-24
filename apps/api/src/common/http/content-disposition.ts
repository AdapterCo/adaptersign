/** Content-Disposition seguro (RFC 6266 / RFC 5987) com nome ASCII de fallback. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_') || 'documento.pdf';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
