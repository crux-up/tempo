import { isIPv6 } from 'node:net';

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The eight hextets of an IPv6 address, with `::` expanded and any zone id dropped. */
function hextets(ip: string): string[] {
  const [head = '', tail] = ip.split('%')[0]!.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((part) => part.replace(/^0+(?=.)/, ''));
}

/**
 * The client a rate limit or per-client budget is charged to (the rate limiter's `keyGenerator` uses it too): an IPv4
 * address (IPv4-mapped IPv6 included) as is, an IPv6 address by its /64 prefix, since one host usually controls a
 * whole /64.
 */
export function clientKey(ip: string): string {
  const mapped = V4_MAPPED.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(ip)) return ip.toLowerCase();
  return `${hextets(ip).slice(0, 4).join(':')}::/64`;
}
