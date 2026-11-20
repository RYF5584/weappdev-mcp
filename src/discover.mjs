// Device discovery: USB / emulator / mDNS / seed file / optional subnet scan.
//
// Design notes
//  1) All sources run in parallel under one 3s budget, so one slow device cannot
//     stall the others.
//  2) USB uses `adb forward tcp:0 tcp:<devicePort>` — `tcp:0` lets adb pick a free
//     local port and echo it back, so forwards never collide across processes or
//     devices.
//  3) Identity is `/json/version` → `device.uuid` (older builds without the field
//     degrade to serial/URL).
//  4) A phone seen over both USB and LAN is merged into one record by uuid.
//
// Zero dependencies: node: builtins plus the adb binary.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dgram from 'node:dgram';
import { log } from './jsonrpc.mjs';

// Re-export so device.mjs can import `log` from here (avoids a second import path).
export { log };

export const DEFAULT_BUDGET_MS = 3000;
const PROBE_TIMEOUT_MS = 1200;
const ADB_TIMEOUT_MS = 4000;
const SEED_PATH = join(homedir(), '.weappdev', 'devices.json');

/** adb availability (cached so we do not spawn per probe). */
let adbChecked = null;

export function adbBin() {
  return process.env.ADB_BIN || 'adb';
}

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

export async function adb(args, timeout = ADB_TIMEOUT_MS) {
  return run(adbBin(), args, timeout);
}

export async function adbAvailable() {
  if (adbChecked !== null) return adbChecked;
  const r = await adb(['version'], 2500);
  adbChecked = r.ok && /Android Debug Bridge/i.test(r.stdout + r.stderr);
  if (!adbChecked) {
    log('adb unavailable (skipping USB/emulator discovery):',
      (r.stderr || r.err || '').toString().slice(0, 120));
  }
  return adbChecked;
}

/** Fetch /json/version and confirm the peer really is a WeAppDev gateway. */
export async function probe(baseUrl, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = baseUrl.replace(/\/+$/, '') + '/json/version';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const j = await res.json();
    // The marker is "WeAppDev" inside Browser. The phone keeps a "WeChat/" prefix
    // for WebUI compatibility, so we must not match on "WeChat".
    const browser = String(j.Browser || '');
    if (!/WeAppDev/i.test(browser)) return { ok: false, reason: 'not-weappdev' };
    const dev = j.device || {};
    const lan = Array.isArray(j.lan) ? j.lan.filter((x) => typeof x === 'string') : [];
    // Exact tool list (newer apps). Older apps omit it, which makes the
    // aggregator fall back to "catalog + tools/list from the device".
    const toolNames = Array.isArray(j.mcpTools) ? j.mcpTools.filter((x) => typeof x === 'string') : [];
    return {
      ok: true,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      uuid: String(dev.uuid || ''),
      model: String(dev.model || ''),
      brand: String(dev.brand || ''),
      android: String(dev.androidVersion || ''),
      serial: String(dev.serial || ''),
      appVersion: String(j['wx-mini-profile']
        ? (j.Browser.match(/WeAppDev\/([^\s]+)/) || [])[1] || '' : ''),
      mcpVersion: String(j.mcpVersion || ''),
      // Integer used for compatibility. Older apps omit it → 0 ("unknown/oldest").
      mcpApiLevel: Number(j.mcpApiLevel || 0),
      mcpProtocols: Array.isArray(j.mcpProtocols) ? j.mcpProtocols : [],
      toolsCount: Number(j.mcpToolsCount || 0),
      // Port the device is actually listening on (0 on older apps).
      gatewayPort: Number(j.gatewayPort || 0),
      toolNames,
      lan,
    };
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'timeout' : String((e && e.message) || e);
    return { ok: false, reason: msg };
  }
}

/** Forwards created by this process (removed on exit). */
const ownedForwards = [];

/** Default gateway port (the app's default; users may change it). */
export const DEFAULT_GATEWAY_PORT = 9400;
/** Android package name (used to read the advertised port file). */
const PKG = 'github.ryf5584.weappdev';
/** When the user changed the port the app may shift it, so probe a small range. */
const PORT_SCAN_SPAN = 12;

/**
 * Read the port the device is actually listening on.
 *
 * The port is user-configurable, and `adb forward` must target the real one.
 * Three sources, most reliable first:
 *  1. `/sdcard/Android/data/<pkg>/files/gateway_port.txt` written by the app
 *     right after a successful bind ("<port> <host> <pid>"). Readable through
 *     `adb shell cat`, independent of logcat throttling and of R8 stripping
 *     `Log.i` in release builds.
 *  2. logcat `listening on host:port` (older app builds only).
 *  3. Give up → 0, and the caller probes 9400..9411.
 */
async function deviceGatewayPort(serial, pkg = PKG) {
  try {
    const r = await adb(['-s', serial, 'shell', 'cat',
      `/sdcard/Android/data/${pkg}/files/gateway_port.txt`], 4000);
    if (r.ok) {
      const m = /^\s*(\d{2,5})\b/.exec(r.stdout);
      if (m) {
        const p = parseInt(m[1], 10);
        if (p >= 1024 && p <= 65535) return p;
      }
    }
  } catch { /* fall through to logcat */ }

  try {
    const r = await adb(['-s', serial, 'logcat', '-d', '-v', 'brief', '-t', '4000'], 5000);
    if (r.ok) {
      const all = [...r.stdout.matchAll(/(?:WAD_GATEWAY_PORT=|listening on )[^\s:]*:(\d{2,5})/g)];
      if (all.length) {
        const p = parseInt(all[all.length - 1][1], 10);
        if (p >= 1024 && p <= 65535) return p;
      }
    }
  } catch { /* fall through to range scan */ }
  return 0;
}

/**
 * Create a forward and return the local port adb assigned.
 *
 * @param devicePort device-side target port (the gateway's real listening port)
 */
async function forwardOne(serial, devicePort) {
  // `adb forward tcp:0 tcp:<port>` echoes only the local port ("64249\n"), not
  // "serial tcp:N tcp:9400". Parse the bare number first, then the prefixed form.
  const r = await adb(['-s', serial, 'forward', 'tcp:0', `tcp:${devicePort}`]);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  let port = 0;
  const bare = /^(\d{2,5})$/.exec(out);
  if (bare) port = parseInt(bare[1], 10);
  else {
    const m = /tcp:(\d+)(?:\s+tcp:\d+)?/.exec(out);
    if (m) port = parseInt(m[1], 10);
  }
  if (!(port > 0)) {
    log('could not parse `adb forward tcp:0` output:', JSON.stringify(out));
    return null;
  }
  ownedForwards.push({ serial, port });
  return port;
}

/** Remove only the forwards this process created. */
export async function releaseForwards() {
  const list = ownedForwards.splice(0, ownedForwards.length);
  for (const f of list) {
    try { await adb(['-s', f.serial, 'forward', '--remove', `tcp:${f.port}`], 2000); } catch {}
  }
}

/** USB + emulator: both appear in `adb devices`, so they share one code path. */
async function discoverUsb(budgetEnd) {
  const out = [];
  if (!(await adbAvailable())) return out;
  const r = await adb(['devices', '-l']);
  if (!r.ok) return out;
  const serials = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+)\s+device\b/.exec(line.trim());
    if (m) serials.push(m[1]);
  }
  await Promise.all(serials.map(async (serial) => {
    const remaining = budgetEnd - Date.now();
    if (remaining < 200) return;
    // Ask the device for its real port first; fall back to scanning the default range.
    const declared = await deviceGatewayPort(serial);
    const candidates = declared > 0
      ? [declared]
      : Array.from({ length: PORT_SCAN_SPAN }, (_, i) => DEFAULT_GATEWAY_PORT + i);
    for (const devPort of candidates) {
      if (budgetEnd - Date.now() < 250) return;
      const port = await forwardOne(serial, devPort);
      if (!port) continue;
      const p = await probe(`http://127.0.0.1:${port}`,
        Math.min(PROBE_TIMEOUT_MS, Math.max(300, budgetEnd - Date.now())));
      if (!p.ok) continue;
      // Verify the port: the device's own gatewayPort must equal the port we
      // forwarded. A mismatch means the advertised/configured port and the real
      // listener disagree (typical: the user changed the port but the app has not
      // restarted yet). Trust the device's answer and reconnect — silently
      // accepting the wrong port would send every later command to a dead port.
      const reported = Number(p.gatewayPort || 0);
      if (reported > 0 && reported !== devPort) {
        log(`⚠ ${serial} port mismatch: advertised=${devPort}, listening=${reported}`
          + ' (app may not have finished restarting after a port change); using the real port.');
        const port2 = await forwardOne(serial, reported);
        if (!port2) return;
        const p2 = await probe(`http://127.0.0.1:${port2}`,
          Math.min(PROBE_TIMEOUT_MS, Math.max(300, budgetEnd - Date.now())));
        if (!p2.ok) return;
        const isEmu2 = /^emulator-/.test(serial) || /^127\.0\.0\.1/.test(serial);
        out.push({
          ...p2, transport: 'usb', serial, forwardPort: port2, emulator: isEmu2,
          devicePort: reported, portMismatch: true,
        });
        return;
      }
      const isEmu = /^emulator-/.test(serial) || /^127\.0\.0\.1:/.test(serial);
      out.push({
        ...p, transport: 'usb', serial, forwardPort: port, emulator: isEmu,
        devicePort: devPort, portMismatch: false,
      });
      return;   // reached this device on its real port; do not try the rest of the range
    }
  }));
  return out;
}

/** mDNS: one PTR query to 224.0.0.251:5353, then collect A/TXT records. */
async function discoverMdns(budgetEnd) {
  const out = [];
  const remaining = budgetEnd - Date.now();
  if (remaining < 400) return out;

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const services = new Map();   // instanceName -> { host, port, txt }

  const buildQuery = () => {
    const labels = ['_weappdev', '_tcp', 'local'];
    const parts = [];
    for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l));
    parts.push(Buffer.from([0]));
    const qname = Buffer.concat(parts);
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0, 0);          // id
    head.writeUInt16BE(0, 2);          // flags
    head.writeUInt16BE(1, 4);          // qdcount
    head.writeUInt16BE(0, 6);
    head.writeUInt16BE(0, 8);
    head.writeUInt16BE(0, 10);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(12, 0);         // PTR
    tail.writeUInt16BE(1, 2);          // IN
    return Buffer.concat([head, qname, tail]);
  };

  const parseName = (buf, off) => {
    const labels = [];
    let p = off;
    let guard = 0;
    while (p < buf.length && guard++ < 128) {
      const len = buf[p];
      if (len === 0) { p++; break; }
      if ((len & 0xc0) === 0xc0) { p += 2; break; }   // compression pointer: not followed
      labels.push(buf.subarray(p + 1, p + 1 + len).toString('utf8'));
      p += 1 + len;
    }
    return { name: labels.join('.'), next: p };
  };

  const onMessage = (msg) => {
    try {
      const qd = msg.readUInt16BE(4);
      const an = msg.readUInt16BE(6);
      let off = 12;
      for (let i = 0; i < qd; i++) {
        const n = parseName(msg, off);
        off = n.next + 4;
      }
      for (let i = 0; i < an; i++) {
        const n = parseName(msg, off);
        off = n.next;
        if (off + 10 > msg.length) break;
        const type = msg.readUInt16BE(off);
        const rdlen = msg.readUInt16BE(off + 8);
        const rdoff = off + 10;
        if (type === 12) {                                  // PTR
          const p = parseName(msg, rdoff);
          const inst = p.name;
          if (inst && !services.has(inst)) services.set(inst, { txt: {} });
        } else if (type === 33) {                            // SRV
          const target = parseName(msg, rdoff + 6);
          const port = msg.readUInt16BE(rdoff + 4);
          for (const [k, v] of services) {
            if (k === n.name || k.endsWith(n.name) || n.name.endsWith(k)) {
              v.host = target.name; v.port = port;
            }
          }
          if (!services.has(n.name)) services.set(n.name, { host: target.name, port, txt: {} });
        } else if (type === 16) {                            // TXT
          const txt = {};
          let p = rdoff;
          const end = rdoff + rdlen;
          while (p < end && p < msg.length) {
            const l = msg[p];
            if (l === 0) { p++; continue; }
            const s = msg.subarray(p + 1, p + 1 + l).toString('utf8');
            const eq = s.indexOf('=');
            if (eq > 0) txt[s.slice(0, eq)] = s.slice(eq + 1);
            p += 1 + l;
          }
          for (const [k, v] of services) {
            if (k === n.name || k.endsWith(n.name) || n.name.endsWith(k)) v.txt = txt;
          }
          if (!services.has(n.name)) services.set(n.name, { txt });
        } else if (type === 1) {                             // A
          const ip = `${msg[rdoff]}.${msg[rdoff + 1]}.${msg[rdoff + 2]}.${msg[rdoff + 3]}`;
          for (const [, v] of services) {
            if (v.host && (v.host === n.name || n.name.endsWith(v.host) || v.host.endsWith(n.name))) v.ip = ip;
          }
        }
        off = rdoff + rdlen;
      }
    } catch { /* one malformed message must not break the rest */ }
  };

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.close(); } catch {} resolve(); };
    sock.on('error', finish);
    sock.on('message', onMessage);
    sock.bind(() => {
      try {
        sock.addMembership('224.0.0.251');
      } catch { /* no multicast permission: keep going, send-only */ }
      try { sock.send(buildQuery(), 5353, '224.0.0.251'); } catch {}
      setTimeout(finish, Math.max(300, Math.min(1500, budgetEnd - Date.now())));
    });
  });

  for (const [, v] of services) {
    const ip = v.ip || (v.host && /^\d+\.\d+\.\d+\.\d+$/.test(v.host) ? v.host : '');
    // Port precedence: TXT `port` (written by the app) > SRV port > default.
    // Some mDNS stacks omit SRV, and TXT is the authoritative value the app owns.
    const txtPort = v.txt && v.txt.port ? parseInt(v.txt.port, 10) : 0;
    const port = (txtPort >= 1024 && txtPort <= 65535) ? txtPort
      : (v.port || DEFAULT_GATEWAY_PORT);
    if (!ip) continue;
    const p = await probe(`http://${ip}:${port}`);
    if (p.ok) out.push({ ...p, transport: 'lan', devicePort: port });
  }
  return out;
}

/** Seed file: user-provided LAN addresses (the only reliable cross-subnet method). */
async function discoverSeed(budgetEnd) {
  const out = [];
  let raw;
  try { raw = await readFile(SEED_PATH, 'utf8'); } catch { return out; }
  let list;
  try {
    const j = JSON.parse(raw);
    list = Array.isArray(j) ? j : (Array.isArray(j.devices) ? j.devices : []);
  } catch { log('seed file is not valid JSON:', SEED_PATH); return out; }
  await Promise.all(list.map(async (e) => {
    if (budgetEnd - Date.now() < 300) return;
    let url = '';
    if (typeof e === 'string') url = e;
    else if (e && e.url) url = String(e.url);
    else if (e && e.host) url = `http://${e.host}:${e.port || DEFAULT_GATEWAY_PORT}`;
    if (!url) return;
    const p = await probe(url);
    if (p.ok) {
      out.push({ ...p, transport: 'lan', seed: true,
        aliasHint: e && e.alias ? String(e.alias) : '' });
    } else {
      log('seed device unreachable:', url, p.reason);
    }
  }));
  return out;
}

/** Optional: scan the local /24 (off by default; enable with --scan). */
async function discoverScan(budgetEnd, ports = null) {
  if (!ports) ports = Array.from({ length: PORT_SCAN_SPAN }, (_, i) => DEFAULT_GATEWAY_PORT + i);
  const out = [];
  const r = await adb(['shell', 'ip', '-4', 'route'], 2500);
  let prefix = '';
  if (r.ok) {
    const m = /\b(\d+\.\d+\.\d+)\.\d+\/\d+ dev \S+ (?:proto \S+ )?(?:src )/i.exec(r.stdout);
    if (m) prefix = m[1];
  }
  if (!prefix) {
    // Fall back to the phone's own IP prefix.
    const ra = await adb(['shell', 'ip', '-4', '-o', 'addr'], 2500);
    if (ra.ok) {
      const m2 = /\binet (\d+\.\d+\.\d+)\.\d+\//.exec(ra.stdout);
      if (m2 && !/^127\./.test(m2[1])) prefix = m2[1];
    }
  }
  if (!prefix) { log('--scan: could not determine the local subnet, skipping'); return out; }

  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);
  const CONC = 50;
  let idx = 0;
  const worker = async () => {
    for (;;) {
      if (budgetEnd - Date.now() < 250) return;
      const i = idx++;
      if (i >= hosts.length) return;
      for (const port of ports) {
        const p = await probe(`http://${hosts[i]}:${port}`, 300);
        if (p.ok) out.push({ ...p, transport: 'lan', scanned: true });
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}

/**
 * Merge the transports of one physical phone into a single record.
 * With a uuid, merge by uuid; without (older app), keep serial / host:port separate.
 */
export function mergeDevices(list) {
  const byKey = new Map();
  for (const d of list) {
    const key = d.uuid ? `uuid:${d.uuid}` : (d.serial ? `serial:${d.serial}` : `url:${d.baseUrl}`);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        key,
        uuid: d.uuid || '',
        model: d.model || '',
        brand: d.brand || '',
        android: d.android || '',
        appVersion: d.appVersion || '',
        mcpVersion: d.mcpVersion || '',
        mcpApiLevel: d.mcpApiLevel || 0,
        mcpProtocols: d.mcpProtocols || [],
        toolsCount: d.toolsCount || 0,
        toolNames: d.toolNames || [],
        // Real gateway port on the device (used for forwards and reconnects).
        devicePort: d.devicePort || 0,
        portMismatch: !!d.portMismatch,
        lan: d.lan || [],
        serial: d.serial || '',
        aliasHint: d.aliasHint || '',
        transports: [d.transport],
        urls: { [d.transport]: d.baseUrl },
        // Prefer USB: lower latency and independent of the Wi-Fi network.
        baseUrl: d.transport === 'usb' ? d.baseUrl : (cur ? cur.baseUrl : d.baseUrl),
      });
    } else {
      if (!cur.transports.includes(d.transport)) cur.transports.push(d.transport);
      cur.urls[d.transport] = cur.urls[d.transport] || d.baseUrl;
      if (d.transport === 'usb') cur.baseUrl = d.baseUrl;      // USB wins
      if (!cur.uuid && d.uuid) cur.uuid = d.uuid;
      if (!cur.serial && d.serial) cur.serial = d.serial;
      if (!cur.aliasHint && d.aliasHint) cur.aliasHint = d.aliasHint;
    }
  }
  return Array.from(byKey.values());
}

/**
 * Run one full discovery round.
 * @param {{scan?: boolean, mdns?: boolean, seed?: boolean, usb?: boolean, budgetMs?: number}} opts
 * @returns {Promise<{devices: Array, tookMs: number, sources: object}>}
 */
export async function discover(opts = {}) {
  const t0 = Date.now();
  const budget = opts.budgetMs || DEFAULT_BUDGET_MS;
  const end = t0 + budget;

  const tasks = [];
  const sources = {};
  if (opts.usb !== false) tasks.push(discoverUsb(end).then((r) => { sources.usb = r.length; return r; }));
  if (opts.mdns !== false) tasks.push(discoverMdns(end).then((r) => { sources.mdns = r.length; return r; }));
  if (opts.seed !== false) tasks.push(discoverSeed(end).then((r) => { sources.seed = r.length; return r; }));
  if (opts.scan) tasks.push(discoverScan(end).then((r) => { sources.scan = r.length; return r; }));

  const results = await Promise.all(tasks);
  const flat = results.flat();
  const devices = mergeDevices(flat);
  return { devices, tookMs: Date.now() - t0, sources };
}

export { SEED_PATH };
