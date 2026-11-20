// stdio JSON-RPC framing. Accepts both framings found in real MCP clients:
//
//   1) Content-Length headers (LSP style) — used by some MCP clients
//   2) Bare newline-delimited JSON — what the MCP stdio transport specifies
//
// We read both because the ecosystem is split and the client picks the framing.
// We always *write* newline-delimited JSON (the spec form), which every client
// can parse.
//
// Zero dependencies: node: builtins only.

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Reads lines (up to `\n`) and returns Buffers without the terminator; EOF is
 * `null`. Hand-rolled instead of `readline` because readline splits large JSON
 * lines per chunk, copies buffers, and cannot switch to Content-Length mode
 * mid-message.
 */
class LineReader {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    this.len = 0;
    this.ended = false;
    this.waiters = [];
    stream.on('data', (c) => {
      this.chunks.push(c);
      this.len += c.length;
      this.flush();
    });
    stream.on('end', () => { this.ended = true; this.flush(); });
    stream.on('error', () => { this.ended = true; this.flush(); });
  }

  flush() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      const r = this.tryRead(w.need);
      if (r === null) break;           // not enough data yet
      this.waiters.shift();
      w.resolve(r);
    }
  }

  /** Read up to `need` bytes (need=null means "up to newline"); null = wait. */
  tryRead(need) {
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.len);
    if (!buf.length && this.ended) return undefined;   // EOF
    if (need === null) {
      const i = buf.indexOf(0x0a);
      if (i < 0) {
        if (this.ended) { this.chunks = []; this.len = 0; return buf.length ? buf : undefined; }
        return null;
      }
      const line = buf.subarray(0, i);
      const rest = buf.subarray(i + 1);
      this.chunks = rest.length ? [rest] : [];
      this.len = rest.length;
      return line;
    }
    if (buf.length < need) return null;
    const out = buf.subarray(0, need);
    const rest = buf.subarray(need);
    this.chunks = rest.length ? [rest] : [];
    this.len = rest.length;
    return out;
  }

  readLine() {
    return new Promise((resolve) => {
      const r = this.tryRead(null);
      if (r !== null) return resolve(r);
      this.waiters.push({ need: null, resolve });
    });
  }

  readExact(n) {
    return new Promise((resolve) => {
      const r = this.tryRead(n);
      if (r !== null) return resolve(r);
      this.waiters.push({ need: n, resolve });
    });
  }
}

export class StdioChannel {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    this.reader = new LineReader(stdin);
    this.out = stdout;
  }

  /**
   * Next parsed message, or null on EOF. Auto-detects Content-Length headers and
   * bare JSON lines.
   */
  async next() {
    for (;;) {
      const line = await this.reader.readLine();
      if (line === undefined || line === null) return null;
      const text = line.toString('utf8').trim();
      if (!text) continue;                                  // blank line: skip

      // Content-Length framing: read headers, then exactly that many bytes.
      if (/^content-length:/i.test(text)) {
        let len = -1;
        let cur = text;
        let guard = 0;
        for (;;) {
          const m = /^content-length:\s*(\d+)$/i.exec(cur);
          if (m) len = parseInt(m[1], 10);
          const nxt = await this.reader.readLine();
          if (nxt === undefined || nxt === null) return null;
          cur = nxt.toString('utf8').trim();
          if (!cur) break;                                   // blank line ends headers
          if (++guard > 100 || cur.length > MAX_HEADER_BYTES) break;
        }
        if (len < 0 || len > MAX_BODY_BYTES) continue;        // bad header: drop frame
        const body = await this.reader.readExact(len);
        if (!body || body === undefined) return null;
        try { return JSON.parse(body.toString('utf8')); } catch { continue; }
      }

      // Bare newline-delimited JSON.
      if (text[0] !== '{' && text[0] !== '[') continue;       // non-JSON noise: skip
      try { return JSON.parse(text); } catch { continue; }
    }
  }

  /** Send one message (newline-delimited; stdout carries protocol data only). */
  send(msg) {
    try {
      this.out.write(JSON.stringify(msg) + '\n');
    } catch {
      // stdout closed (client exited): stay silent and let the process exit
    }
  }
}

/** stderr logging. stdout is the protocol channel and must stay clean. */
export function log(...args) {
  try { process.stderr.write('[weappdev-mcp] ' + args.join(' ') + '\n'); } catch {}
}
