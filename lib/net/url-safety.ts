// Decides whether a URL is safe to fetch on a user's (or a model's) say-so.
// Only public http(s) addresses pass. Anything that points at this machine, a
// private network or a cloud metadata service is refused, which is what stops
// a bot from being used to reach internal services (SSRF).
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

// Resolves a host name to its addresses. Tests pass their own.
export type HostLookup = (hostname: string) => Promise<string[]>

const defaultLookup: HostLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export const MAX_URL_LENGTH = 2000

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".")
  if (parts.length !== 4) {
    return null
  }

  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet > 255) {
      return null
    }
    value = value * 256 + octet
  }
  return value
}

// [first address, prefix length] for every IPv4 range that isn't the public
// internet: this network, private, shared (CGNAT), loopback, link-local
// (which includes cloud metadata at 169.254.169.254), protocol assignments,
// documentation, benchmarking, multicast and reserved.
const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]

function isPublicIpv4(address: string) {
  const value = ipv4ToNumber(address)
  if (value === null) {
    return false
  }

  return !BLOCKED_IPV4.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix)
    const start = ipv4ToNumber(base)!
    return value >= start && value < start + size
  })
}

// Expands an IPv6 address to its eight 16-bit groups, or null if it isn't one.
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const zone = text.indexOf("%")
  if (zone !== -1) {
    text = text.slice(0, zone)
  }

  // An IPv4 tail ("::ffff:10.0.0.1") becomes two groups.
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    const value = ipv4ToNumber(tail)
    if (value === null) {
      return null
    }
    text = `${text.slice(0, lastColon + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }

  const halves = text.split("::")
  if (halves.length > 2) {
    return null
  }

  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null
  }

  const groups = [...head, ...Array(Math.max(missing, 0)).fill(0), ...rest]
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
    ? groups
    : null
}

function isPublicIpv6(address: string) {
  const groups = ipv6Groups(address)
  if (!groups) {
    return false
  }

  const embeddedV4 = () =>
    `${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`

  // Unspecified (::) and loopback (::1).
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] <= 1) {
    return false
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the
  // IPv4 address inside.
  if (groups.slice(0, 5).every((group) => group === 0)) {
    if (groups[5] === 0xffff || groups[5] === 0) {
      return isPublicIpv4(embeddedV4())
    }
  }
  // NAT64 (64:ff9b::/96) also carries an IPv4 address.
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPublicIpv4(embeddedV4())
  }
  // IPv4-translated (::ffff:0:a.b.c.d) carries an IPv4 address too.
  if (
    groups.slice(0, 4).every((group) => group === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0
  ) {
    return isPublicIpv4(embeddedV4())
  }
  // 6to4 (2002::/16) puts an IPv4 address right after the prefix.
  if (groups[0] === 0x2002) {
    return isPublicIpv4(
      `${groups[1] >>> 8}.${groups[1] & 0xff}.${groups[2] >>> 8}.${groups[2] & 0xff}`
    )
  }
  // Teredo (2001:0::/32) tunnels IPv4; documentation (2001:db8::/32).
  if (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8)) {
    return false
  }

  // Only global unicast (2000::/3) is public. Everything else (unique local,
  // link-local, site-local, multicast, discard, reserved) is not: this list
  // allows what is known to be public instead of blocking what is known not to be.
  return (groups[0] & 0xe000) === 0x2000
}

export function isPublicAddress(address: string) {
  const version = isIP(address)
  if (version === 4) {
    return isPublicIpv4(address)
  }
  if (version === 6) {
    return isPublicIpv6(address)
  }
  return false
}

// Names that only ever mean "this machine" or "this network".
function isLocalName(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home.arpa") ||
    // A bare word with no dot is an intranet name.
    !hostname.includes(".")
  )
}

// Checks one URL. The host name is resolved and every address it has must be
// public, so a public-looking name that points at 10.0.0.1 is refused too.
export async function checkPublicUrl(
  input: string,
  lookup: HostLookup = defaultLookup
): Promise<UrlCheck> {
  if (typeof input !== "string" || input.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "The URL is too long." }
  }

  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { ok: false, reason: "That isn't a valid URL." }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https URLs are allowed." }
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with a username or password aren't allowed." }
  }
  // The usual web ports only: other ports are where databases, admin panels and
  // caches listen.
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "Only the standard web ports (80 and 443) are allowed." }
  }

  // URL already turns odd spellings of an IPv4 address (decimal, hex, octal)
  // into dotted form, and wraps IPv6 in brackets.
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (!hostname) {
    return { ok: false, reason: "That isn't a valid URL." }
  }

  const blocked = { ok: false as const, reason: "That address isn't on the public internet." }

  if (isIP(hostname)) {
    return isPublicAddress(hostname) ? { ok: true, url } : blocked
  }
  if (isLocalName(hostname.toLowerCase())) {
    return blocked
  }

  let addresses: string[]
  try {
    addresses = await lookup(hostname)
  } catch {
    return { ok: false, reason: "That site couldn't be found." }
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "That site couldn't be found." }
  }

  return addresses.every(isPublicAddress) ? { ok: true, url } : blocked
}
