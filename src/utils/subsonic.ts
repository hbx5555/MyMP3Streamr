import { escapeXml } from './crypto.js';

export const SUBSONIC_VERSION = '1.16.1';

export function wrapSubsonicResponse(inner: string, status: 'ok' | 'failed' = 'ok'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi" status="${status}" version="${SUBSONIC_VERSION}">${inner}</subsonic-response>`;
}

export function subsonicErrorXml(code: number, message: string): string {
  return wrapSubsonicResponse(`<error code="${code}" message="${escapeXml(message)}" />`, 'failed');
}

function attr(key: string, value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return '';
  return ` ${key}="${escapeXml(String(value))}"`;
}

export function xmlElement(name: string, attrs: Record<string, string | number | boolean | undefined | null> = {}, children = ''): string {
  const renderedAttrs = Object.entries(attrs).map(([key, value]) => attr(key, value)).join('');
  if (!children) {
    return `<${name}${renderedAttrs} />`;
  }
  return `<${name}${renderedAttrs}>${children}</${name}>`;
}

export function xmlTextElement(name: string, text: string, attrs: Record<string, string | number | boolean | undefined | null> = {}): string {
  return xmlElement(name, attrs, escapeXml(text));
}
