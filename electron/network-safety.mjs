import { BlockList, isIP } from "node:net";

function createAddressBlockList(subnets, family) {
  const blockList = new BlockList();
  for (const [network, prefix] of subnets) {
    blockList.addSubnet(network, prefix, family);
  }
  return blockList;
}

// IANA special-purpose ranges. IPv6 uses a public allow-list so ULA,
// link-local, multicast, mapped IPv4 and future reserved space fail closed.
const NON_PUBLIC_IPV4 = createAddressBlockList(
  [
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
  ],
  "ipv4",
);
const PUBLIC_IPV6 = createAddressBlockList([["2000::", 3]], "ipv6");
const NON_PUBLIC_IPV6 = createAddressBlockList(
  [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ],
  "ipv6",
);

export function proxyRouteKind(value) {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const routes = value
    .split(";")
    .map((route) => route.trim())
    .filter(Boolean);
  if (routes.length === 0) return "unknown";
  let hasProxy = false;
  for (const route of routes) {
    if (/^DIRECT$/i.test(route)) continue;
    if (
      /^(?:PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5|QUIC)(?:\s+|:\/\/)\S+$/i.test(
        route,
      )
    ) {
      hasProxy = true;
      continue;
    }
    return "unknown";
  }
  return hasProxy ? "proxy" : "direct";
}

export function isNonPublicIpAddress(address) {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC_IPV4.check(address, "ipv4");
  if (family === 6) {
    return (
      !PUBLIC_IPV6.check(address, "ipv6") ||
      NON_PUBLIC_IPV6.check(address, "ipv6")
    );
  }
  return true;
}

export function isPrivateNetworkHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  return isIP(normalized) !== 0 && isNonPublicIpAddress(normalized);
}
