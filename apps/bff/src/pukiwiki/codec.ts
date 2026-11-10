import iconv from 'iconv-lite';

/** Byte-level encoding helpers for talking to a PukiWiki in its own charset. */
export class Codec {
  readonly encoding: string;
  private badCache = new Map<string, boolean>();

  constructor(encoding: string) {
    this.encoding = encoding.toLowerCase() === 'utf-8' ? 'utf-8' : 'euc-jp';
  }

  encode(s: string): Buffer {
    return iconv.encode(s, this.encoding);
  }

  decode(b: Buffer | Uint8Array): string {
    return iconv.decode(Buffer.from(b), this.encoding);
  }

  /** Percent-encode a string as bytes in the wiki charset (like PHP rawurlencode). */
  q(s: string): string {
    let out = '';
    for (const byte of this.encode(s)) {
      const c = String.fromCharCode(byte);
      out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }

  /** application/x-www-form-urlencoded body/query in the wiki charset. */
  form(fields: Record<string, string | undefined>): string {
    return Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${this.q(k)}=${this.q(v as string)}`)
      .join('&');
  }

  /** Decode a percent-encoded value that was encoded in the wiki charset. */
  unq(s: string): string {
    const bytes: number[] = [];
    const t = s.replace(/\+/g, ' ');
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '%' && /^[0-9a-fA-F]{2}$/.test(t.slice(i + 1, i + 3))) {
        bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        for (const b of Buffer.from(t[i], 'utf8')) bytes.push(b);
      }
    }
    return this.decode(Buffer.from(bytes));
  }

  /** Characters that cannot be represented in the wiki charset, with positions. */
  unencodable(s: string): { index: number; char: string }[] {
    if (this.encoding === 'utf-8') return [];
    const out: { index: number; char: string }[] = [];
    let i = 0;
    for (const ch of s) {
      if (ch.charCodeAt(0) >= 0x80) {
        let bad = this.badCache.get(ch);
        if (bad === undefined) {
          bad = iconv.decode(iconv.encode(ch, this.encoding), this.encoding) !== ch;
          this.badCache.set(ch, bad);
        }
        if (bad) out.push({ index: i, char: ch });
      }
      i += ch.length;
    }
    return out;
  }
}

export function htmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
