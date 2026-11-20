// Device registry + phone session mapping + self-healing.
//
// Invariants (read before changing anything here)
//  1) **Zero resolution in steady state**: once a device is attached, a call is a
//     Map lookup plus one HTTP forward. Re-resolution happens only on first use
//     or after "connection refused / 404".
//  2) **Lazy session binding**: initialize a phone only when a call is actually
//     routed to it, so one offline device cannot stall every tools/call.
//  3) **Retry only when the call definitely did not execute**:
//     ECONNREFUSED/ECONNRESET/404 are retried once; timeouts are never retried
//     (retrying could execute wad_click twice).
//  4) **One attach lock per device** so concurrent reconnects cannot create
//     orphan sessions.

import { discover, probe, releaseForwards, log } from './discover.mjs';
import { API_LEVEL, SERVER_VERSION } from './version.mjs';
import { META_TOOL_API_LEVEL } from './capabilities.mjs';

const CLIENT_INFO = { name: 'weappdev-mcp', version: SERVER_VERSION };
const PROTOCOL = '2025-06-18';
/** Proxy timeout must exceed the phone's 45s tool watchdog, or structured phone
 *  errors would surface as generic network failures. */
const CALL_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 12_000;
/**
 * Discovery cache TTL.
 *
 * Why 60s and not 5s: an mDNS round always costs 0.8–1.5s, so a short TTL makes
 * every call that arrives after a pause look like "each command hangs for a
 * second", which is exactly what invariant 1 forbids. Hot-plugging and IP
 * changes are handled by the error paths (`refreshTransport` and a forced
 * `ensureDiscovered`), not by a short TTL.
 */
const DISCOVER_TTL_MS = 60_000;

export class DeviceError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.code = code;
    this.hint = hint;
  }
  toToolError() {
    const o = { ok: false, error: this.code, message: this.message, retryable: false };
    if (this.hint) o.hint = this.hint;
    return o;
  }
}

function isConnError(e) {
  if (!e) return false;
  const code = e.code || '';
  const msg = String(e.message || '');
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE'
    || code === 'ENOTFOUND' || code === 'EHOSTUNREACH'
    || /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed/i.test(msg);
}

function isTimeout(e) {
  return !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'));
}

export class Registry {
  constructor(opts = {}) {
    this.opts = {
      scan: !!opts.scan,
      mdns: opts.mdns !== false,
      seed: opts.seed !== false,
      usb: opts.usb !== false,
      budgetMs: opts.budgetMs,
    };
    /** @type {Map<string, any>} key → record */
    this.devices = new Map();
    /** alias / short id / url → key */
    this.index = new Map();
    /** Sticky default device for this process (set by wad_device_use). */
    this.sticky = '';
    this.lastDiscoverAt = 0;
    /** One attach lock per device. */
    this.attachLocks = new Map();
    this.discovering = null;
  }

  // ────────────────────────────────────────────── discovery

  /** Discover on demand (TTL cache + single-flight, so concurrent calls scan once). */
  async ensureDiscovered({ force = false } = {}) {
    const now = Date.now();
    if (!force) {
      // Devices known and still fresh → use them (steady state: no scan, no wait).
      if (this.devices.size > 0 && now - this.lastDiscoverAt < DISCOVER_TTL_MS) {
        return this.devices;
      }
      // Devices known but stale: do **not** block this call — keep using the old
      // table and refresh in the background.
      if (this.devices.size > 0 && !this.discovering) {
        this.refreshInBackground();
        return this.devices;
      }
    }
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      try {
        const { devices, tookMs, sources } = await discover(this.opts);
        this.applyDiscovery(devices);
        this.lastDiscoverAt = Date.now();
        log(`discovered ${this.devices.size} device(s) in ${tookMs}ms`, JSON.stringify(sources));
        return this.devices;
      } finally {
        this.discovering = null;
      }
    })();
    return this.discovering;
  }

  /** Background refresh: failures are logged and the old table is kept. */
  refreshInBackground() {
    if (this.discovering) return;
    this.discovering = (async () => {
      try {
        const { devices, tookMs, sources } = await discover(this.opts);
        this.applyDiscovery(devices);
        this.lastDiscoverAt = Date.now();
        log(`background refresh: ${this.devices.size} device(s) in ${tookMs}ms`, JSON.stringify(sources));
      } catch (e) {
        log('background refresh failed (keeping the previous table):',
          String(e && e.message || e).slice(0, 80));
      } finally {
        this.discovering = null;
      }
    })();
  }

  /**
   * Merge one discovery round into the registry, keeping phone sessions alive.
   *
   * Devices that were seen before but not reached in this round are **kept** and
   * marked offline: one phone going away must not erase another. Keeping the
   * record also preserves the alias and session so `refreshTransport` can revive
   * it later.
   */
  applyDiscovery(devices) {
    const prev = this.devices;
    const next = new Map();
    const index = new Map();
    const seen = new Set();
    for (const d of devices) {
      const old = prev.get(d.key);
      const rec = {
        ...d,
        alias: (old && old.alias) || d.aliasHint || this.shortAlias(d),
        phoneSid: (old && old.phoneSid) || '',
        attachedAt: (old && old.attachedAt) || 0,
        lastUsedAt: (old && old.lastUsedAt) || 0,
        online: true,
      };
      next.set(rec.key, rec);
      seen.add(rec.key);
    }
    for (const [k, old] of prev) {
      if (seen.has(k)) continue;
      next.set(k, { ...old, online: false });
    }
    for (const rec of next.values()) {
      if (rec.alias) index.set(rec.alias.toLowerCase(), rec.key);
      if (rec.uuid) {
        index.set(rec.uuid.toLowerCase(), rec.key);
        const short = rec.uuid.replace(/^wad-/, '').slice(0, 8);
        if (short) index.set(short.toLowerCase(), rec.key);
      }
      if (rec.serial) index.set(('usb:' + rec.serial).toLowerCase(), rec.key);
      for (const u of Object.values(rec.urls || {})) {
        if (u) index.set(u.replace(/\/+$/, '').toLowerCase(), rec.key);
      }
    }
    this.devices = next;
    this.index = index;
  }

  reindex(rec) {
    if (rec.alias) this.index.set(rec.alias.toLowerCase(), rec.key);
    if (rec.uuid) {
      this.index.set(rec.uuid.toLowerCase(), rec.key);
      // Short id = uuid without the `wad-` prefix, first 8 chars (alias fallback).
      const short = rec.uuid.replace(/^wad-/, '').slice(0, 8);
      if (short) this.index.set(short.toLowerCase(), rec.key);
    }
    if (rec.serial) this.index.set(('usb:' + rec.serial).toLowerCase(), rec.key);
    for (const u of Object.values(rec.urls || {})) {
      if (u) this.index.set(u.replace(/\/+$/, '').toLowerCase(), rec.key);
    }
  }

  shortAlias(d) {
    if (d.uuid) {
      const short = d.uuid.replace(/^wad-/, '').slice(0, 8);
      if (short) return short;
    }
    if (d.serial) return String(d.serial).replace(/[^\w.-]/g, '');
    try { return new URL(d.baseUrl).host.replace(/[^\w.-]/g, ''); } catch { return 'device'; }
  }

  // ────────────────────────────────────────────── routing

  /**
   * Decide which device a call goes to.
   *
   * Deterministic order — never a random pick:
   *   1. explicit `device` (alias / uuid / base URL)
   *   2. this process's sticky device (wad_device_use)
   *   3. exactly one device online → use it
   *   4. several online and none specified → E_AMBIGUOUS_DEVICE with the list
   */
  async resolve(explicit) {
    await this.ensureDiscovered();
    const list = Array.from(this.devices.values());
    if (list.length === 0) {
      throw new DeviceError('E_NO_DEVICE',
        'No WeAppDev device was discovered',
        'Check: 1) USB connected and the app running; 2) or put LAN addresses in '
        + '~/.weappdev/devices.json; 3) or pass --scan');
    }
    // "online" = actually reached in this round. Offline records are kept so their
    // sessions can be revived, but automatic selection only considers online ones
    // (otherwise one offline phone would turn "the only device" into an ambiguity).
    const online = list.filter((d) => d.online !== false);

    const want = (explicit || '').trim();
    if (want) {
      const hit = await this.resolveExplicit(want);
      if (hit) return hit;
      throw new DeviceError('E_UNKNOWN_DEVICE',
        `Unknown device: ${want}`,
        'Call wad_devices to list devices. `device` accepts an alias, a uuid, or http://host:port');
    }

    if (this.sticky) {
      const hit = await this.resolveExplicit(this.sticky);
      if (hit && hit.online !== false) return hit;
      log('sticky device is no longer available, clearing:', this.sticky);
      this.sticky = '';
    }

    if (online.length === 1) return online[0];
    if (online.length === 0) {
      throw new DeviceError('E_NO_DEVICE',
        'No WeAppDev device is online (every known record is offline)',
        'Check that USB/the app is running, or call wad_devices to inspect state');
    }

    throw new DeviceError('E_AMBIGUOUS_DEVICE',
      `${online.length} devices are online; specify one with \`device\``,
      'Call wad_device_use to pin a default, or pass `device` per call: '
        + online.map((d) => d.alias).join(' / '));
  }

  /** The three accepted forms of an explicit device. */
  async resolveExplicit(want) {
    const key = this.index.get(want.toLowerCase());
    if (key && this.devices.has(key)) return this.devices.get(key);

    // Base URL: probe once to read the uuid, then cache it in the index.
    if (/^https?:\/\//i.test(want)) {
      const url = want.replace(/\/+$/, '');
      const p = await probe(url);
      if (!p.ok) {
        throw new DeviceError('E_BAD_BASE_URL',
          `Not a usable WeAppDev gateway: ${url} (${p.reason})`,
          'The address looks like http://192.168.1.5:9400 (use the port shown in the '
          + 'app\'s Dev config), with the app running and bound to 0.0.0.0');
      }
      // Already known by uuid → reuse the record and fill in the LAN URL.
      const byUuid = p.uuid ? this.devices.get(`uuid:${p.uuid}`) : null;
      if (byUuid) {
        byUuid.urls.lan = byUuid.urls.lan || url;
        byUuid.baseUrl = byUuid.baseUrl || url;
        this.reindex(byUuid);
        return byUuid;
      }
      const rec = {
        key: p.uuid ? `uuid:${p.uuid}` : `url:${url}`,
        ...p,
        alias: this.shortAlias({ ...p, baseUrl: url }),
        transports: ['lan'],
        urls: { lan: url },
        baseUrl: url,
        phoneSid: '',
        attachedAt: 0,
        lastUsedAt: 0,
      };
      this.devices.set(rec.key, rec);
      this.reindex(rec);
      return rec;
    }

    // The value may be a uuid prefix (the short id shown by wad_devices).
    const short = want.toLowerCase().replace(/^wad-/, '');
    for (const [k, rec] of this.devices) {
      if (rec.uuid && rec.uuid.toLowerCase().replace(/^wad-/, '').startsWith(short)) {
        this.index.set(want.toLowerCase(), k);
        return rec;
      }
    }
    return null;
  }

  // ────────────────────────────────────────────── phone sessions (attach)

  /**
   * Ensure a usable phone session. Returns { baseUrl, sid }.
   *
   * Lazy binding plus one lock per device: concurrent attaches initialize once.
   */
  async attach(rec) {
    if (rec.phoneSid) return { baseUrl: rec.baseUrl, sid: rec.phoneSid };
    const pending = this.attachLocks.get(rec.key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const r = await this.phoneInitialize(rec.baseUrl);
        rec.phoneSid = r.sid;
        rec.attachedAt = Date.now();
        rec.mcpVersion = r.mcpVersion || rec.mcpVersion;
        rec.toolsCount = r.toolsCount || rec.toolsCount;
        log('attached', rec.alias, r.sid);
        return { baseUrl: rec.baseUrl, sid: rec.phoneSid };
      } finally {
        this.attachLocks.delete(rec.key);
      }
    })();
    this.attachLocks.set(rec.key, p);
    return p;
  }

  async phoneInitialize(baseUrl) {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO },
      }),
      signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new DeviceError('E_DEVICE_HTTP', `initialize failed with HTTP ${res.status}`,
        `device: ${baseUrl}`);
    }
    const sid = res.headers.get('mcp-session-id') || '';
    if (!sid) throw new DeviceError('E_NO_SESSION', 'Device returned no Mcp-Session-Id',
      `device: ${baseUrl}`);
    const body = await res.json().catch(() => ({}));
    const info = (body && body.result && body.result.serverInfo) || {};
    const toolsCount = Number((body && body.result && body.result.serverInfo
      && body.result.serverInfo.toolsCount) || 0);
    // The spec requires a notifications/initialized after initialize. The phone
    // answers 202; failures here are irrelevant.
    try {
      await fetch(baseUrl.replace(/\/+$/, '') + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {}
    return { sid, mcpVersion: info.version || '', toolsCount };
  }

  /** Drop the session (called after a 404 or a connection error). */
  resetSession(rec) {
    rec.phoneSid = '';
    rec.attachedAt = 0;
  }

  // ────────────────────────────────────────────── forwarding

  /**
   * Forward one RPC to a device, with self-healing.
   *
   * @param {any} rec device record
   * @param {object} payload {jsonrpc,id,method,params}
   * @returns {Promise<object>} the raw JSON-RPC response from the phone
   */
  async forward(rec, payload) {
    const attempt = async () => {
      const { baseUrl, sid } = await this.attach(rec);
      const res = await fetch(baseUrl.replace(/\/+$/, '') + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sid,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      return { res, baseUrl };
    };

    let out;
    try {
      out = await attempt();
    } catch (e) {
      if (isTimeout(e)) {
        // Unknown whether it executed → never retry (prevents a double wad_click).
        throw new DeviceError('E_DEVICE_TIMEOUT',
          `Device ${rec.alias} did not respond within ${CALL_TIMEOUT_MS / 1000}s`,
          'Check device state with wad_status; re-pin with wad_device_use if needed');
      }
      if (isConnError(e)) {
        // Transport died (app restart invalidated the forward port, or the LAN IP changed).
        log('connection failed, re-resolving transport:', rec.alias,
          String(e.message || e).slice(0, 80));
        await this.refreshTransport(rec);
        this.resetSession(rec);
        out = await attempt();
      } else {
        throw e;
      }
    }

    if (out.res.status === 404) {
      // Phone-side session expired (app restart or 30min idle) → definitely not
      // executed, so one retry is safe.
      log('session expired (404), re-attaching and retrying:', rec.alias);
      this.resetSession(rec);
      out = await attempt();
      if (out.res.status === 404) {
        throw new DeviceError('E_SESSION_LOST',
          `Device ${rec.alias} rejected the session (404)`,
          'The device may have just restarted; retry once, or re-pin with wad_device_use');
      }
    }

    if (!out.res.ok) {
      const text = await out.res.text().catch(() => '');
      throw new DeviceError('E_DEVICE_HTTP',
        `Device ${rec.alias} returned HTTP ${out.res.status}`,
        text.slice(0, 200));
    }
    const json = await out.res.json().catch(() => null);
    if (!json) throw new DeviceError('E_DEVICE_BAD_JSON', `Device ${rec.alias} returned non-JSON`, '');
    rec.lastUsedAt = Date.now();
    return json;
  }

  /** Re-resolve this one device's transport (does not rescan everything). */
  async refreshTransport(rec) {
    // First try the record's other transports (usb ↔ lan).
    for (const [t, url] of Object.entries(rec.urls || {})) {
      if (!url || url === rec.baseUrl) continue;
      const p = await probe(url, 1200);
      if (p.ok) {
        log('switching transport', t, url);
        rec.baseUrl = url;
        return;
      }
    }
    // Nothing works: rebuild the forward for this serial (the usual USB case).
    if (rec.serial) {
      const { adb, deviceGatewayPort, DEFAULT_GATEWAY_PORT } = await import('./discover.mjs');
      // The user may have changed the port, so ask the device first.
      const declared = await deviceGatewayPort(rec.serial);
      const candidates = declared > 0
        ? [declared]
        : [DEFAULT_GATEWAY_PORT, rec.devicePort].filter((p, i, a) => p && a.indexOf(p) === i);
      for (const devPort of candidates) {
        const r = await adb(['-s', rec.serial, 'forward', 'tcp:0', `tcp:${devPort}`]);
        const out = r.ok ? r.stdout.trim() : '';
        const m = /^(\d{2,5})$/.exec(out) || /tcp:(\d+)(?:\s+tcp:\d+)?/.exec(out);
        if (!m) continue;
        const url = `http://127.0.0.1:${m[1]}`;
        const p = await probe(url, 1500);
        if (p.ok) {
          rec.baseUrl = url;
          rec.urls.usb = url;
          rec.devicePort = devPort;
          return;
        }
      }
    }
    // Last resort: re-discover (the IP may have changed).
    await this.ensureDiscovered({ force: true });
    const again = this.devices.get(rec.key);
    if (again && again.baseUrl) rec.baseUrl = again.baseUrl;
  }

  // ────────────────────────────────────────────── tool surface

  /** Payload for wad_devices. */
  listPayload() {
    const list = Array.from(this.devices.values()).map((d) => ({
      device: d.alias,
      // online:false means "seen before, not reached this round"; the session is
      // kept so it can be revived.
      online: d.online !== false,
      uuid: d.uuid || '',
      model: d.model || '',
      brand: d.brand || '',
      android: d.android || '',
      serial: d.serial || '',
      transports: d.transports,
      baseUrl: d.baseUrl,
      lanUrls: d.lan || [],
      appVersion: d.appVersion || '',
      // Version triple: human-readable version, integer for compatibility, tool count.
      mcpVersion: d.mcpVersion || '',
      mcpApiLevel: Number(d.mcpApiLevel || 0),
      toolsCount: d.toolsCount || 0,
      // Real device-side gateway port; portMismatch means the advertised port and
      // the actual listener disagreed (resolved in favour of what is listening).
      devicePort: Number(d.devicePort || 0),
      portMismatch: !!d.portMismatch,
      // Whether this device can be introspected through wad_tools.
      metaTool: (Number(d.mcpApiLevel || 0) >= META_TOOL_API_LEVEL)
        || (Array.isArray(d.toolNames) && d.toolNames.includes('wad_tools')),
      default: d.key === this.defaultKey(),
      bound: !!d.phoneSid,
      lastUsedAt: d.lastUsedAt || 0,
    }));
    return {
      ok: true,
      count: list.length,
      sticky: this.sticky,
      // This server's own version: a newer aggregator advertises tools that older
      // phones do not have.
      aggregator: { version: SERVER_VERSION, apiLevel: API_LEVEL },
      devices: list,
    };
  }

  defaultKey() {
    if (this.sticky) {
      const k = this.index.get(this.sticky.toLowerCase());
      if (k) return k;
    }
    if (this.devices.size === 1) return Array.from(this.devices.keys())[0];
    return '';
  }

  /** Pin the sticky default device. */
  async use(device) {
    await this.ensureDiscovered();
    const rec = await this.resolveExplicit(String(device || '').trim());
    if (!rec) {
      throw new DeviceError('E_UNKNOWN_DEVICE',
        `Unknown device: ${device}`,
        'Call wad_devices to list devices');
    }
    this.sticky = rec.alias;
    return {
      ok: true,
      device: rec.alias,
      uuid: rec.uuid || '',
      note: 'Subsequent calls in this process default to this device; pass `device` to override',
    };
  }

  async shutdown() {
    await releaseForwards();
  }
}

export { CALL_TIMEOUT_MS };
