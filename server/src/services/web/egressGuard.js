import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../config/env.js';

/**
 * Outbound-request guard for live web retrieval.
 *
 * Every URL this module vets came, directly or indirectly, from a search engine
 * — which means from the public internet. Treating those URLs as trusted would
 * turn retrieval into a server-side request forgery primitive pointed at the
 * ATOZAS VPS's own network: MongoDB on 27017, Redis on 6379, llama-server on
 * 8081, and on a cloud host the instance metadata service on 169.254.169.254,
 * which hands out credentials to anyone who asks.
 *
 * So the rules are deliberately strict and deny-by-default:
 *
 *  1. http/https only. No file:, gopher:, data: or ftp:.
 *  2. Default ports only. Fetching :6379 has no legitimate retrieval purpose.
 *  3. Every hostname is resolved, and every resolved address must be a global
 *     unicast address. This is the check that stops `internal.example.com`
 *     resolving to 10.0.0.5, and it is why the DNS answer is resolved here
 *     rather than left to fetch().
 *  4. Redirects are followed manually (see fetchPage.js) and each hop is
 *     re-vetted, because a public URL is free to 302 to a private one and a
 *     pre-flight check alone would miss it.
 *
 * The residual gap is DNS rebinding: the name could resolve differently between
 * this check and the socket connect. Closing it fully requires pinning the
 * connection to the vetted IP, which means a custom agent per request. The
 * mitigation taken instead is that responses are only ever parsed as HTML and
 * fed to the model as quoted, untrusted text — never executed, never used to
 * make a further request — so a rebind yields unusable text rather than access.
 */

/** Ports a public web page can legitimately live on. */
const ALLOWED_PORTS = new Set(['', '80', '443']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** @typedef {{ ok: true, url: URL, addresses: string[] }} Allowed */
/** @typedef {{ ok: false, reason: string }} Denied */

/**
 * True for addresses that are not globally routable, i.e. everything that could
 * only be reachable because the request originates inside ATOZAS's network.
 */
export function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  // Not an IP literal at all: refuse rather than guess.
  return true;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 carrier NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(ip) {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (addr === '::' || addr === '::1') return true; // unspecified + loopback
  if (addr.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (addr.startsWith('ff')) return true; // multicast

  // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 verdict, otherwise the
  // v4 private ranges would be reachable through a v6 literal.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

/** Matches a host against a suffix rule, so "gov.uk" also allows "www.gov.uk". */
function matchesDomain(hostname, rule) {
  const host = hostname.toLowerCase();
  const domain = rule.toLowerCase().replace(/^\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Applies the operator's domain policy. An empty allowlist means "any public
 * host"; a populated one is exclusive, which is the recommended production
 * posture because it bounds what the model can end up quoting.
 */
export function isDomainAllowed(hostname) {
  const { allowedDomains, blockedDomains } = env.web;

  if (blockedDomains.some((rule) => matchesDomain(hostname, rule))) return false;
  if (!allowedDomains.length) return true;
  return allowedDomains.some((rule) => matchesDomain(hostname, rule));
}

/**
 * Vets one outbound URL.
 *
 * @param {string} rawUrl
 * @returns {Promise<Allowed|Denied>}
 */
export async function vetUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: 'malformed_url' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `protocol_not_allowed:${url.protocol}` };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: `port_not_allowed:${url.port}` };
  }
  // Credentials in a retrieval URL are always either a mistake or an attempt to
  // smuggle auth to an internal service.
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials_in_url' };
  }
  if (!isDomainAllowed(url.hostname)) {
    return { ok: false, reason: 'domain_not_allowed' };
  }

  // An IP literal needs no DNS round trip, but does need the same range check.
  if (net.isIP(url.hostname)) {
    return isPrivateAddress(url.hostname)
      ? { ok: false, reason: 'private_address' }
      : { ok: true, url, addresses: [url.hostname] };
  }

  let resolved;
  try {
    resolved = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }

  if (!resolved.length) return { ok: false, reason: 'dns_empty' };

  // Every answer must be public. Rejecting on *any* private address, rather
  // than picking a public one, denies a split-horizon DNS record the chance to
  // hand us the internal address on the connection that matters.
  const addresses = resolved.map((r) => r.address);
  if (addresses.some((address) => isPrivateAddress(address))) {
    return { ok: false, reason: 'private_address' };
  }

  return { ok: true, url, addresses };
}

export default vetUrl;
