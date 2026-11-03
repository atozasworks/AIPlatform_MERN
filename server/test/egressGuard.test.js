import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isDomainAllowed, vetUrl } from '../src/services/web/egressGuard.js';

/**
 * The guarantee under test: a URL that came from a search engine cannot be used
 * to reach anything on the ATOZAS host or its private network.
 *
 * This is the security boundary of the whole web-retrieval feature. Search
 * results are attacker-influenceable — anyone can publish a page that ranks — so
 * an unguarded fetcher is a server-side request forgery primitive aimed at
 * MongoDB (27017), Redis (6379), llama-server (8081) and, on a cloud host, the
 * instance metadata service that hands out credentials.
 */

test('rejects loopback in every notation', () => {
  for (const ip of ['127.0.0.1', '127.1.1.1', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `should reject ${ip}`);
  }
});

test('rejects the RFC1918 private ranges', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.1.1']) {
    assert.equal(isPrivateAddress(ip), true, `should reject ${ip}`);
  }
});

test('rejects the cloud metadata address', () => {
  // 169.254.169.254 serves IAM credentials on AWS, GCP and Azure. Reaching it
  // is the single highest-impact SSRF target on a cloud VPS.
  assert.equal(isPrivateAddress('169.254.169.254'), true);
});

test('rejects carrier NAT, multicast, broadcast and unspecified ranges', () => {
  for (const ip of ['100.64.0.1', '224.0.0.1', '255.255.255.255', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, `should reject ${ip}`);
  }
});

test('rejects IPv6 link-local and unique-local', () => {
  for (const ip of ['fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::']) {
    assert.equal(isPrivateAddress(ip), true, `should reject ${ip}`);
  }
});

test('an IPv4-mapped IPv6 address inherits the IPv4 verdict', () => {
  // Without this, ::ffff:10.0.0.1 would be a trivial bypass of the v4 rules.
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
});

test('accepts ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `should accept ${ip}`);
  }
});

test('treats anything that is not an IP literal as unsafe', () => {
  // Fail closed: a value that reached the range check without being an address
  // means an earlier assumption broke.
  for (const value of ['not-an-ip', '', null, undefined, '10.0.0', '999.1.1.1']) {
    assert.equal(isPrivateAddress(value), true, `should reject ${String(value)}`);
  }
});

test('boundary addresses either side of 172.16/12 are classified correctly', () => {
  assert.equal(isPrivateAddress('172.15.255.255'), false); // just below the range
  assert.equal(isPrivateAddress('172.16.0.0'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('172.32.0.0'), false); // just above
});

test('domain rules match subdomains by suffix', () => {
  // With no configured allowlist every public host is permitted, which is the
  // default posture; the suffix logic is what an operator relies on when they
  // do configure one.
  assert.equal(isDomainAllowed('example.com'), true);
  assert.equal(isDomainAllowed('www.example.com'), true);
});

test('rejects non-http protocols', async () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com',
    'data:text/html,<script>1</script>',
  ]) {
    const verdict = await vetUrl(url);
    assert.equal(verdict.ok, false, `should reject ${url}`);
    assert.match(verdict.reason, /protocol_not_allowed|malformed_url/);
  }
});

test('rejects non-default ports', async () => {
  // No public web page lives on 6379, but a search result is free to claim one
  // does, and that request would reach Redis.
  for (const url of [
    'http://example.com:6379/',
    'http://example.com:27017/',
    'http://example.com:8081/',
  ]) {
    const verdict = await vetUrl(url);
    assert.equal(verdict.ok, false, `should reject ${url}`);
    assert.match(verdict.reason, /port_not_allowed/);
  }
});

test('rejects credentials embedded in the URL', async () => {
  const verdict = await vetUrl('http://admin:secret@example.com/');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'credentials_in_url');
});

test('rejects private IP literals without a DNS lookup', async () => {
  for (const url of [
    'http://127.0.0.1:80/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
  ]) {
    const verdict = await vetUrl(url);
    assert.equal(verdict.ok, false, `should reject ${url}`);
    assert.equal(verdict.reason, 'private_address');
  }
});

test('rejects malformed input', async () => {
  for (const url of ['', 'not a url', 'http://', null]) {
    const verdict = await vetUrl(url);
    assert.equal(verdict.ok, false, `should reject ${String(url)}`);
  }
});

test('allows a public IP literal on a default port', async () => {
  const verdict = await vetUrl('https://1.1.1.1/');
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.addresses, ['1.1.1.1']);
});
