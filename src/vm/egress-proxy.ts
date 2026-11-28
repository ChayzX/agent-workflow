// Allowlist egress proxy for agent VMs, run on the control plane (`orchestrator egress-proxy`). Guests can reach
// nothing but this proxy (VirtualBox NAT + Windows Firewall rules, deploy/devvm/Set-EgressFirewall.ps1); the proxy
// in turn reaches only allowlisted host names, and never a private, loopback, link-local or otherwise internal
// address, even when an allowlisted name resolves to one (no LAN, router, control-plane services or Pantry Bot).
//
// - HTTPS: CONNECT host:443 is tunnelled to the address the proxy resolved and checked (no DNS rebinding).
// - HTTP: absolute-URI requests (Debian mirrors) are forwarded; package files (.deb) are cached on disk.
// - Every decision is appended to a JSONL log.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface EgressPolicy {
  allowHosts: string[]; denyHosts: string[]; allowPorts: number[]; allowClients: string[];
}
export interface EgressOptions extends EgressPolicy {
  listen: string; port: number; logFile: string | null; cacheDir: string | null; cacheMaxMb: number;
  /** Tests only: resolver override and permission to reach loopback test servers. */
  resolve?: (host: string) => Promise<string[]>;
  allowLoopbackForTests?: boolean;
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '');
}

function matches(host: string, pattern: string): boolean {
  const p = normalizeHost(pattern);
  return p.startsWith('.') ? host === p.slice(1) || host.endsWith(p) : host === p;
}

/** Name-level decision (before DNS). */
export function hostDecision(policy: EgressPolicy, rawHost: string, port: number): { ok: true } | { ok: false; reason: string } {
  const host = normalizeHost(rawHost);
  if (isIP(host) || isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'IP literals are not allowed; use an allowlisted host name' };
  if (!HOST_RE.test(host)) return { ok: false, reason: 'invalid host name' };
  if (!policy.allowPorts.includes(port)) return { ok: false, reason: `port ${port} is not allowed` };
  if (policy.denyHosts.some((d) => matches(host, d))) return { ok: false, reason: 'host is on the deny list' };
  if (!policy.allowHosts.some((a) => matches(host, a))) return { ok: false, reason: 'host is not on the allowlist' };
  return { ok: true };
}

function v4(addr: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  return m ? m.slice(1).map(Number) : null;
}

/** True for any address that is not plainly public unicast (RFC 1918, CGNAT, loopback, link-local, ULA, ...). */
export function isInternalAddress(addr: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  const a = v4(mapped ? mapped[1]! : addr);
  if (a) {
    const [x, y] = a as [number, number, number, number];
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
      || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  const s = addr.toLowerCase();
  if (s === '::' || s === '::1') return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8') || s.startsWith('::ffff:');
}

export class EgressProxy {
  private server: Server | null = null;
  readonly stats = { allowed: 0, denied: 0, cacheHits: 0 };
  constructor(private opts: EgressOptions) {}

  private log(entry: Record<string, unknown>): void {
    if (!this.opts.logFile) return;
    try { appendFileSync(this.opts.logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 }); } catch { /* logging must not break traffic */ }
  }

  private clientAllowed(addr: string | undefined): boolean {
    if (!this.opts.allowClients.length) return true;
    const a = (addr ?? '').replace(/^::ffff:/, '');
    return this.opts.allowClients.includes(a);
  }

  /** Resolve and pick a public address; refuse if any resolved address is internal. */
  private async target(host: string): Promise<{ ok: true; addr: string } | { ok: false; reason: string }> {
    let addrs: string[];
    try { addrs = this.opts.resolve ? await this.opts.resolve(host) : (await lookup(host, { all: true, verbatim: true })).map((x) => x.address); }
    catch { return { ok: false, reason: 'name does not resolve' }; }
    if (!addrs.length) return { ok: false, reason: 'name does not resolve' };
    const internal = addrs.filter((a) => isInternalAddress(a) && !(this.opts.allowLoopbackForTests && (a === '127.0.0.1' || a === '::1')));
    if (internal.length) return { ok: false, reason: `resolves to an internal address (${internal[0]})` };
    return { ok: true, addr: addrs[0]! };
  }

  private async decide(client: string | undefined, host: string, port: number): Promise<{ ok: true; addr: string } | { ok: false; reason: string }> {
    if (!this.clientAllowed(client)) return { ok: false, reason: `client ${client} is not allowed to use this proxy` };
    const d = hostDecision(this.opts, host, port);
    if (!d.ok) return d;
    return this.target(normalizeHost(host));
  }

  private deny(kind: string, client: string | undefined, host: string, port: number, reason: string): void {
    this.stats.denied++;
    this.log({ decision: 'deny', kind, client, host, port, reason });
  }

  start(): Promise<{ port: number }> {
    const server = createServer((req, res) => { void this.onRequest(req, res); });
    server.on('connect', (req: IncomingMessage, sock: Socket, head: Buffer) => { void this.onConnect(req, sock, head); });
    server.on('clientError', (_e, sock) => sock.destroy());
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.listen, () => resolve({ port: (server.address() as { port: number }).port }));
    });
  }

  stop(): Promise<void> {
    return new Promise((r) => { if (!this.server) return r(); this.server.close(() => r()); this.server.closeAllConnections?.(); });
  }

  private async onConnect(req: IncomingMessage, sock: Socket, head: Buffer): Promise<void> {
    const client = req.socket.remoteAddress;
    const m = /^([^:\s]+):(\d{1,5})$/.exec(req.url ?? '');
    sock.on('error', () => sock.destroy());
    if (!m) { this.deny('connect', client, req.url ?? '', 0, 'malformed CONNECT target'); sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = m[1]!; const port = Number(m[2]);
    const d = await this.decide(client, host, port);
    if (!d.ok) { this.deny('connect', client, host, port, d.reason); sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\negress refused: ${d.reason}\n`); return; }
    const upstream = connect(port, d.addr);
    upstream.on('error', () => { sock.destroy(); });
    upstream.on('connect', () => {
      this.stats.allowed++;
      this.log({ decision: 'allow', kind: 'connect', client, host, port, addr: d.addr });
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(sock); sock.pipe(upstream);
    });
    sock.on('close', () => upstream.destroy());
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = req.socket.remoteAddress;
    let url: URL;
    try { url = new URL(req.url ?? ''); } catch { res.writeHead(400).end('absolute URL required\n'); return; }
    if (url.protocol !== 'http:' || (req.method !== 'GET' && req.method !== 'HEAD')) { this.deny('http', client, url.hostname, 0, 'only GET/HEAD over plain HTTP are proxied; use CONNECT for HTTPS'); res.writeHead(403).end('egress refused\n'); return; }
    const port = Number(url.port || 80);
    const d = await this.decide(client, url.hostname, port);
    if (!d.ok) { this.deny('http', client, url.hostname, port, d.reason); res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`egress refused: ${d.reason}\n`); return; }
    const cacheable = req.method === 'GET' && !!this.opts.cacheDir && /\.(deb|udeb)$/.test(url.pathname);
    const key = cacheable ? join(this.opts.cacheDir!, createHash('sha256').update(url.href).digest('hex')) : null;
    if (key && existsSync(key)) {
      this.stats.cacheHits++; this.stats.allowed++;
      this.log({ decision: 'allow', kind: 'http-cache', client, host: url.hostname, path: url.pathname });
      res.writeHead(200, { 'Content-Type': 'application/vnd.debian.binary-package', 'Content-Length': statSync(key).size });
      createReadStream(key).pipe(res);
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !/^(proxy-|connection$|keep-alive$|te$|trailer$|upgrade$|transfer-encoding$)/i.test(k)) headers[k] = v;
    headers.host = url.host;
    const up = httpRequest({ host: d.addr, port, method: req.method, path: url.pathname + url.search, headers }, (ur) => {
      this.stats.allowed++;
      this.log({ decision: 'allow', kind: 'http', client, host: url.hostname, path: url.pathname, status: ur.statusCode });
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      if (key && ur.statusCode === 200) {
        mkdirSync(this.opts.cacheDir!, { recursive: true, mode: 0o700 });
        const tmp = `${key}.${randomBytes(4).toString('hex')}.part`;
        const file = createWriteStream(tmp, { mode: 0o600 });
        ur.pipe(file);
        ur.on('end', () => file.end(() => { try { renameSync(tmp, key); this.evict(); } catch { /* ignore */ } }));
        ur.on('error', () => { file.destroy(); try { unlinkSync(tmp); } catch { /* gone */ } });
      }
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502).end('upstream error\n'); else res.destroy(); });
    req.pipe(up);
  }

  /** Keep the cache under cacheMaxMb by removing the least recently written files. */
  private evict(): void {
    const dir = this.opts.cacheDir!;
    const files = readdirSync(dir).filter((f) => /^[0-9a-f]{64}$/.test(f)).map((f) => ({ f, s: statSync(join(dir, f)) })).sort((a, b) => a.s.mtimeMs - b.s.mtimeMs);
    let total = files.reduce((n, x) => n + x.s.size, 0);
    for (const x of files) {
      if (total <= this.opts.cacheMaxMb * 1024 * 1024) break;
      try { unlinkSync(join(dir, x.f)); total -= x.s.size; } catch { /* raced */ }
    }
  }
}
