const ALREADY_NORMAL = /^(?:\/[a-z0-9_\-~]+)*$|^\/$/;

/**
 * Canonical form of a request path for matching and keying.
 *
 * Without this, a limit on "/auth/login" is bypassed by "/AUTH/login", "/auth//login",
 * "/auth/./login", "/auth/%6Cogin" or "/auth/login?x=1" — all of which most backends
 * route to the same handler. We err on the side of merging paths (stricter limits)
 * rather than splitting them.
 */
export function normalizeRoute(raw: string): string {
  if (ALREADY_NORMAL.test(raw)) return raw;
  let path = raw;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (path.includes('%')) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // Malformed escapes: keep the raw text, it still gets lowercased below.
    }
  }
  path = path.toLowerCase();

  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

export interface RouteMatcher {
  pattern: string;
  test(path: string): boolean;
}

/**
 * Patterns: "/auth/login" (exact), "/users/:id" (one segment), "/api/*" (prefix).
 * Matching runs against the normalised path.
 */
export function compileRoutePattern(pattern: string): RouteMatcher {
  const normal = normalizeRoute(pattern.replace(/\/\*$/, ''));
  const wildcard = pattern.endsWith('/*');
  if (!wildcard && !normal.includes(':')) {
    return { pattern: normal, test: (path) => path === normal };
  }
  const body = normal
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  const prefix = body === '/' ? '' : body;
  const regex = new RegExp(`^${prefix}${wildcard ? '(?:/.*)?' : ''}$`);
  return { pattern: wildcard ? `${normal === '/' ? '' : normal}/*` : normal, test: (path) => regex.test(path) };
}
