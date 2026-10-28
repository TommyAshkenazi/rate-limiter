/**
 * Everything about IP addresses, re-exported from small single-purpose files:
 *   ip-parse.ts       text  -> numbers
 *   ip-mask.ts        keep the first N bits (subnet grouping)
 *   ip-format.ts      numbers -> canonical text
 *   client-ip-key.ts  parse + mask + format = the key used for rate limiting
 *   cidr.ts           "is this address inside 10.0.0.0/8?"
 */
export { Cidr } from './cidr';
export { clientIpKey } from './client-ip-key';
export { formatIp } from './ip-format';
export { maskIp } from './ip-mask';
export { parseIp, type ParsedIp } from './ip-parse';
