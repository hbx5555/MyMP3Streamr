import crypto from 'node:crypto';

export function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

export function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomId(prefix = ''): string {
  return `${prefix}${crypto.randomUUID()}`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function basicXmlHeader(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>';
}
