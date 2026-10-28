import { describe, expect, it } from 'vitest';
import { ClientIpResolver } from '../src/extractors/client-ip-resolver';
import { Cidr, clientIpKey, parseIp } from '../src/extractors/ip';
import { normalizeRoute } from '../src/extractors/route';
import { req, setup, times } from './helpers';

describe('[4] IPv6 /64 subnet masking', () => {
  const perIp = {
    id: 'per-ip',
    algorithm: 'token-bucket' as const,
    capacity: 3,
    refillRatePerSecond: 0.001,
    keyStrategy: { dimensions: ['ip' as const], ipv6SubnetMask: 64 },
  };

  it('two different addresses within the same /64 share one pool', () => {
    const { engine } = setup({ t1: [perIp] });
    // Same /64 (2001:db8:85a3:0::/64), different interface identifiers and notations.
    const a = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    const b = '2001:db8:85a3::dead:beef';
    const c = '2001:DB8:85A3:0:ffff:ffff:ffff:ffff';
    expect(engine.evaluate(req({ clientIp: a })).allowed).toBe(true);
    expect(engine.evaluate(req({ clientIp: b })).allowed).toBe(true);
    expect(engine.evaluate(req({ clientIp: c })).allowed).toBe(true);
    // An attacker cycling through 2^64 addresses still hits the same bucket.
    expect(engine.evaluate(req({ clientIp: '2001:db8:85a3::1234' })).allowed).toBe(false);
    // The neighbouring /64 is a different subscriber.
    expect(engine.evaluate(req({ clientIp: '2001:db8:85a3:1::1' })).allowed).toBe(true);
  });

  it('IPv4 stays per-address, and IPv4-mapped IPv6 is the same client as plain IPv4', () => {
    const { engine } = setup({ t1: [perIp] });
    times(3, () => engine.evaluate(req({ clientIp: '198.51.100.7' })));
    expect(engine.evaluate(req({ clientIp: '::ffff:198.51.100.7' })).allowed).toBe(false);
    expect(engine.evaluate(req({ clientIp: '198.51.100.8' })).allowed).toBe(true);
  });

  it('canonicalises and masks addresses', () => {
    expect(clientIpKey('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:db8:85a3::/64');
    expect(clientIpKey('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:db8:1::/48');
    expect(clientIpKey('2001:db8::1', 128)).toBe('2001:db8::1');
    expect(clientIpKey('fe80::1%eth0')).toBe('fe80::/64');
    expect(clientIpKey('[2001:db8::1]:443')).toBe('2001:db8::/64');
    expect(clientIpKey('::1')).toBe('::/64');
    expect(clientIpKey('203.0.113.77')).toBe('203.0.113.77');
    expect(clientIpKey('203.0.113.77:51234')).toBe('203.0.113.77');
    expect(clientIpKey('203.0.113.77', 64, 24)).toBe('203.0.113.0/24');
    expect(clientIpKey('not-an-ip')).toBe('invalid');
    expect(clientIpKey('1:0:0:1:0:0:0:1', 128)).toBe('1:0:0:1::1');
  });

  it('matches CIDRs', () => {
    const v4 = Cidr.parse('10.0.0.0/8');
    expect(v4.contains(parseIp('10.255.1.2')!)).toBe(true);
    expect(v4.contains(parseIp('11.0.0.1')!)).toBe(false);
    expect(v4.contains(parseIp('::ffff:10.1.2.3')!)).toBe(true);
    const v6 = Cidr.parse('2400:cb00::/32');
    expect(v6.contains(parseIp('2400:cb00:1::5')!)).toBe(true);
    expect(v6.contains(parseIp('2400:cb01::5')!)).toBe(false);
  });
});

describe('trusted proxy / X-Forwarded-For handling', () => {
  const resolver = new ClientIpResolver({ trustedProxies: ['10.0.0.0/8', '2001:db8:ffff::/48'] });

  it('ignores X-Forwarded-For from an untrusted peer (spoofing attempt)', () => {
    expect(resolver.resolve('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' })).toBe('203.0.113.9');
  });

  it('takes the right-most untrusted hop, not the client-controlled left-most', () => {
    // Client sent "XFF: 1.2.3.4"; our LB appended the real address it saw.
    expect(resolver.resolve('10.0.0.5', { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' })).toBe('198.51.100.7');
    // Two layers of our own proxies.
    expect(resolver.resolve('10.0.0.5', { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' })).toBe('198.51.100.7');
    // Repeated XFF header lines are concatenated.
    expect(resolver.resolve('10.0.0.5', { 'x-forwarded-for': ['1.2.3.4', '198.51.100.7'] })).toBe('198.51.100.7');
  });

  it('handles mapped/IPv6 peers and all-trusted chains', () => {
    expect(resolver.resolve('::ffff:10.0.0.5', { 'x-forwarded-for': '2001:db8::1' })).toBe('2001:db8::1');
    expect(resolver.resolve('2001:db8:ffff::1', { 'x-forwarded-for': '198.51.100.1' })).toBe('198.51.100.1');
    expect(resolver.resolve('10.0.0.5', { 'x-forwarded-for': '10.1.1.1' })).toBe('10.1.1.1');
    expect(resolver.resolve('10.0.0.5', {})).toBe('10.0.0.5');
  });

  it('stops at a malformed hop instead of trusting what lies beyond it', () => {
    expect(resolver.resolve('10.0.0.5', { 'x-forwarded-for': '1.2.3.4, garbage' })).toBe('10.0.0.5');
  });

  it('honours a CDN client-ip header only when the peer is trusted', () => {
    const cf = new ClientIpResolver({ trustedProxies: ['10.0.0.0/8'], clientIpHeader: 'CF-Connecting-IP' });
    expect(cf.resolve('10.0.0.5', { 'cf-connecting-ip': '198.51.100.20' })).toBe('198.51.100.20');
    expect(cf.resolve('203.0.113.1', { 'cf-connecting-ip': '198.51.100.20' })).toBe('203.0.113.1');
  });
});

describe('route normalisation (limits on expensive routes cannot be bypassed)', () => {
  it('canonicalises equivalent paths', () => {
    for (const p of ['/auth/login', '/AUTH/Login', '/auth//login', '/auth/./login/', '/auth/x/../login', '/auth/%6Cogin', '/auth/login?next=/'])
      expect(normalizeRoute(p)).toBe('/auth/login');
  });

  it('applies the login limit to every spelling of the route', () => {
    const { engine } = setup({
      t1: [
        {
          id: 'login',
          algorithm: 'sliding-window',
          capacity: 3,
          windowSizeSeconds: 60,
          keyStrategy: { dimensions: ['ip', 'route'] },
          match: { methods: ['POST'], routes: ['/auth/login'] },
        },
      ],
    });
    const spellings = ['/auth/login', '/Auth/Login', '//auth/login/', '/auth/%6cogin?x=1'];
    const results = spellings.map((route) => engine.evaluate(req({ route, method: 'post' })));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    // GET is not covered by the POST-only policy.
    expect(engine.evaluate(req({ route: '/auth/login', method: 'GET' })).policyId).toBeUndefined();
  });

  it('keys :param routes by pattern so ids in the path do not create a bucket each', () => {
    const { engine } = setup({
      t1: [
        {
          id: 'orders',
          algorithm: 'token-bucket',
          capacity: 2,
          refillRatePerSecond: 0.001,
          keyStrategy: { dimensions: ['ip', 'route'] },
          match: { routes: ['/orders/:id', '/admin/*'] },
        },
      ],
    });
    expect(engine.evaluate(req({ route: '/orders/1' })).allowed).toBe(true);
    expect(engine.evaluate(req({ route: '/orders/2' })).allowed).toBe(true);
    expect(engine.evaluate(req({ route: '/orders/3' })).allowed).toBe(false);
    expect(engine.evaluate(req({ route: '/admin/users/9' })).allowed).toBe(true);
    expect(engine.evaluate(req({ route: '/orders' })).policyId).toBeUndefined();
    expect(engine.getTenantMetrics('t1').activeTrackedKeys).toBe(2);
  });
});
