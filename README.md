# weappdev-mcp

MCP server for [WeAppDev](https://github.com/RYF5584/weappdev-mcp) — configure it **once** and drive
one or many Android phones (USB, emulator, or LAN) from any MCP client.

The Android app itself is the MCP server (64 tools covering mini-program automation, network and
native capture, cloud calls, breakpoints, DOM, WebSocket lifecycle and plugins). This package is a
thin **stdio aggregator** on top of it: it discovers phones, keeps one MCP session per device, and
routes each call to the phone you ask for.

No resident daemon. Your MCP client spawns the process and it exits with the session, so each AI
conversation gets its own independent registry.

```
MCP client ──stdio──▶ weappdev-mcp ──HTTP──▶ phone A :9400/mcp
                          │            └────▶ phone B :9400/mcp  (LAN)
                          └──── adb forward tcp:0 (USB / emulator, port assigned by adb)
```

## Requirements

- **Node.js >= 22** (global `fetch`, `AbortSignal.timeout`, `node:dgram`)
- **adb** on `PATH` for USB/emulator discovery (override with `ADB_BIN`)
- The WeAppDev app running on the phone

## Configure your client

```json
{
  "mcpServers": {
    "weappdev": {
      "command": "npx",
      "args": ["-y", "@ryf5584/weappdev-mcp"]
    }
  }
}
```

This is the whole configuration. You do not need one entry per phone, and plugging in another phone
requires no change here.

## Choosing a device

```
wad_devices                                  # list phones; `device` is the alias
wad_device_use { "device": "0017f447" }      # pin the default for THIS session
wad_status                                   # no device → uses the pinned one
wad_status { "device": "b96e8eee" }          # one-off override
```

`device` accepts an alias (`0017f447`), the persistent install UUID
(`wad-0017f44719ad...`), or a base URL (`http://192.168.1.5:9400`).

Routing is deterministic and never guesses:

1. the `device` passed on the call
2. the device pinned with `wad_device_use` in this process
3. exactly one device online → use it
4. several online and none specified → `E_AMBIGUOUS_DEVICE` with the full list

## Ports

The phone serves MCP (`/mcp`), CDP (`/devtools/*`, `/json/*`) and its internal API (`/v1/*`) on a
**single configurable port**, default `9400`. Change it in the app under *Dev config*; no
configuration is needed here because the aggregator reads the port the device is actually listening
on and falls back gracefully on older builds.

USB forwarding uses `adb forward tcp:0 tcp:<devicePort>`: adb picks a free local port, so two
aggregators (or two phones) can never collide. Each process removes only the forwards it created.

## CLI

```
npx -y @ryf5584/weappdev-mcp                       # normal use
node src/cli.mjs --scan                   # also scan the local /24 (9400-9411)
node src/cli.mjs --no-mdns                # disable mDNS discovery
node src/cli.mjs --no-seed                # ignore ~/.weappdev/devices.json
node src/cli.mjs --no-usb                 # disable adb discovery
node src/cli.mjs --debug                  # verbose logs on stderr
node src/cli.mjs --version                # print version
```

Environment: `ADB_BIN` (default `adb`).

## Discovery

Each round runs all sources in parallel under a 3s budget.

| Source | Default | Notes |
|---|---|---|
| USB / emulator (`adb devices`) | on | local port auto-assigned with `tcp:0` |
| mDNS (`_weappdev._tcp`) | on | may be blocked by AP isolation |
| `~/.weappdev/devices.json` | on | for LAN and cross-subnet |
| Local `/24` scan | off (`--scan`) | ports 9400–9411 |

Seed file format:

```json
[
  { "url": "http://192.168.1.5:9400", "alias": "living-room" },
  { "host": "192.168.1.6", "port": 9400 },
  "http://192.168.1.7:9400"
]
```

Devices are deduplicated by persistent install UUID; the same phone seen over USB and LAN becomes
one record with `transports: ["usb","lan"]`, preferring USB.

## Tool table

`tools/list` returns the **union** across connected devices plus two aggregator-only tools
(`wad_devices`, `wad_device_use`). Every tool carries `_meta.devices` (aliases that support it) and
`_meta.unsupportedBy`.

If a phone is too old for a tool, the call fails with a structured error instead of an opaque one:

```json
{
  "ok": false,
  "error": "E_UNSUPPORTED_BY_DEVICE",
  "message": "0017f447 does not support wad_xyz (phone MCP 1.0.0 / apiLevel 100)",
  "hint": "0017f447 does not support wad_xyz (...). Call wad_tools {action:'list'} to see what it does support."
}
```

If the phone is **newer** than this package, its extra tools still work: they are picked up from the
device's own tool list, and completely unknown names are forwarded through the phone's `wad_tools`
meta tool.

## Versioning

Two independent numbers, both surfaced by `initialize` and `/json/version`:

| Field | Meaning |
|---|---|
| `version` | semver of the MCP server — informational only |
| `apiLevel` | monotonic capability generation (integer) — the only input to compatibility decisions |

Semver strings are never compared, so `1.10 < 1.9` style mistakes cannot happen.

## Error codes

| Code | Meaning |
|---|---|
| `E_NO_DEVICE` | nothing discovered (USB? app running? try `--scan`) |
| `E_AMBIGUOUS_DEVICE` | several devices online, none selected |
| `E_UNKNOWN_DEVICE` | `device` did not match; call `wad_devices` |
| `E_UNSUPPORTED_BY_DEVICE` | that phone's app version lacks the tool |
| `E_BAD_BASE_URL` | the URL is not a WeAppDev gateway |
| `E_DEVICE_TIMEOUT` | 60s with no response — **never retried**, so side effects cannot run twice |
| `E_SESSION_LOST` | re-attach also got 404; the device is probably restarting |
| `E_DEVICE_HTTP` / `E_DEVICE_BAD_JSON` | the phone returned an unexpected response |

Transient connection failures (`ECONNREFUSED` / `ECONNRESET`) and expired sessions (HTTP 404) are
retried **once**. Timeouts are deliberately not retried.

## Development

```bash
npm run check     # syntax check every module
npm test          # node:test unit suite (no device required)
node scripts/validate-server-json.mjs
```

Publishing is automated: push a `v*` tag and `.github/workflows/release.yml` runs the tests,
publishes to npm with provenance, then publishes the entry to the official MCP Registry.

## License

MIT
