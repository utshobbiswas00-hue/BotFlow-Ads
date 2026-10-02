/**
 * Minimal cookie read/write helpers.
 *
 * Hand-rolled rather than pulling in `cookie-parser`: the panel needs exactly one
 * cookie read and two cookies written, and this codebase's dependency list is
 * deliberately small. `cookie` happens to be present in node_modules as a
 * transitive dependency of Express, but importing a package that is not in
 * package.json would break on the next clean install — so it is not imported.
 *
 * Deliberately NOT implemented: Signed cookies. The session cookie holds a
 * 256-bit random identifier, not a payload, and the server never trusts anything
 * from the cookie beyond looking that identifier up. A signature would add
 * nothing — an attacker cannot forge a lookup that does not exist.
 */

export interface CookieOptions {
  /** Seconds until the browser drops it. */
  maxAge: number;
  /** JS cannot read it. Always true for the session id. */
  httpOnly: boolean;
  /** Only sent over HTTPS. Forced on in production. */
  secure: boolean;
  /** 'Strict' means a cross-site request never carries it at all. */
  sameSite: 'Strict' | 'Lax' | 'None';
  path: string;
}

/**
 * Read one cookie without parsing the whole jar into an object.
 * Returns null for a missing, malformed or empty value.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;

    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not a valid cookie value we wrote.
      return null;
    }
  }
  return null;
}

/**
 * Build a `Set-Cookie` value.
 *
 * `SameSite=Strict` is the default posture here: the panel and the API are the
 * same origin, so Strict costs nothing and means a cross-site request never even
 * carries the session cookie. CSRF is still enforced independently — see
 * `middleware/adminPanelAuth.ts` — because defence in depth that is cheap is
 * worth having.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** A `Set-Cookie` that clears the cookie (Max-Age=0). */
export function clearCookie(name: string, options: Pick<CookieOptions, 'path' | 'secure' | 'sameSite'>): string {
  return serializeCookie(name, '', { ...options, maxAge: 0, httpOnly: true });
}

/** Append a Set-Cookie without clobbering any already queued on this response. */
export function appendSetCookie(res: { getHeader(name: string): unknown; setHeader(name: string, value: unknown): void }, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [String(existing), cookie]);
}
