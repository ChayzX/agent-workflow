import { randomUUID, createHash, randomBytes } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const uuid = (): string => randomUUID();
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function slugify(s: string, max = 40): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'item';
}
