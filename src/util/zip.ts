// Dependency-free ZIP writer/reader (deflate via node:zlib, CRC32 via zlib.crc32).
// Deterministic output: fixed timestamps and sorted entries make releases reproducible.
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';

export interface ZipEntry { name: string; data: Buffer; mode?: number }

const DOS_TIME = 0;          // 00:00:00
const DOS_DATE = (1 << 5) | 1 | ((2026 - 1980) << 9); // 2026-01-01

export function writeZip(path: string, entries: ZipEntry[]): void {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.name.split(sep).join('/'), 'utf8');
    const crc = crc32(e.data) >>> 0;
    const comp = deflateRawSync(e.data, { level: 9 });
    const useStore = comp.length >= e.data.length;
    const body = useStore ? e.data : comp;
    const method = useStore ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE((3 << 8) | 20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((((e.mode ?? 0o100644) & 0xffff) << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([...chunks, cdBuf, end]));
}

export function readZip(path: string): ZipEntry[] {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26);
    const lxlen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`unsupported method ${method}`); })();
    if ((crc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.push({ name, data, mode: attrs >>> 16 });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Extract safely: rejects absolute paths and path traversal (zip-slip). */
export function extractZip(path: string, dest: string): string[] {
  const root = resolve(dest);
  const names: string[] = [];
  for (const e of readZip(path)) {
    const target = resolve(root, e.name);
    if (!target.startsWith(root + sep)) throw new Error(`unsafe path in archive: ${e.name}`);
    if (e.name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data, { mode: (e.mode ?? 0o644) & 0o777 || 0o644 });
    names.push(e.name);
  }
  return names;
}

export function collectDir(root: string, prefix: string, skip: (rel: string) => boolean = () => false): ZipEntry[] {
  const out: ZipEntry[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = relative(root, p);
      if (skip(rel)) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push({ name: `${prefix}/${rel.split(sep).join('/')}`, data: readFileSync(p), mode: 0o100000 | (st.mode & 0o777) });
    }
  };
  walk(root);
  return out;
}
