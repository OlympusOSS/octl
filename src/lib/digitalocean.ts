const DO_API = "https://api.digitalocean.com/v2";

/** Ports that need to be open on the Olympus production droplet. */
const OLYMPUS_INBOUND_PORTS = [
	"22",        // SSH
	"80",        // HTTP (reverse proxy / certbot)
	"443",       // HTTPS
	"3001",      // CIAM Hera
	"3003",      // CIAM Athena
	"3100-3103", // CIAM Kratos + Hydra
	"4001",      // IAM Hera
	"4003",      // IAM Athena
	"4100-4103", // IAM Kratos + Hydra
];

interface DropletNetwork {
	ip_address: string;
	type: "public" | "private";
}

interface Droplet {
	id: number;
	name: string;
	networks: { v4: DropletNetwork[] };
}

export interface DropletInfo {
	id: number;
	name: string;
	ip: string;
}

/**
 * List all Droplets with their public IPs.
 */
export async function listDroplets(token: string): Promise<DropletInfo[]> {
	const res = await fetch(`${DO_API}/droplets?per_page=200`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`DigitalOcean API error (${res.status}): ${body}`);
	}

	const data: { droplets: Droplet[] } = await res.json();
	return data.droplets
		.map((d) => ({
			id: d.id,
			name: d.name,
			ip: d.networks.v4.find((n) => n.type === "public")?.ip_address ?? "",
		}))
		.filter((d) => d.ip);
}

/**
 * Look up a Droplet's public IPv4 by name using the DigitalOcean REST API.
 * Throws if the Droplet is not found or has no public IP.
 */
export async function lookupDropletIp(token: string, name: string): Promise<string> {
	const droplets = await listDroplets(token);
	const droplet = droplets.find((d) => d.name === name);

	if (!droplet) {
		const available = droplets.map((d) => d.name).join(", ");
		throw new Error(`Droplet "${name}" not found. Available: ${available || "(none)"}`);
	}

	return droplet.ip;
}

export interface DropletSize {
	slug: string;
	vcpus: number;
	memory: number; // MB
	disk: number; // GB
	priceMonthly: number;
	regions: string[];
}

/**
 * List available Droplet sizes with pricing.
 * Filters to shared CPU sizes only (s- prefix) for simplicity.
 */
export async function listSizes(token: string): Promise<DropletSize[]> {
	const res = await fetch(`${DO_API}/sizes?per_page=200`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`DigitalOcean API error (${res.status}): ${body}`);
	}

	const data = await res.json();
	return (data.sizes ?? [])
		.filter((s: any) => s.available && s.slug.startsWith("s-"))
		.map((s: any) => ({
			slug: s.slug,
			vcpus: s.vcpus,
			memory: s.memory,
			disk: s.disk,
			priceMonthly: s.price_monthly,
			regions: s.regions ?? [],
		}))
		.sort((a: DropletSize, b: DropletSize) => a.priceMonthly - b.priceMonthly);
}

export interface Region {
	slug: string;
	name: string;
	available: boolean;
}

/**
 * List available regions.
 */
export async function listRegions(token: string): Promise<Region[]> {
	const res = await fetch(`${DO_API}/regions?per_page=200`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`DigitalOcean API error (${res.status}): ${body}`);
	}

	const data = await res.json();
	return (data.regions ?? [])
		.filter((r: any) => r.available)
		.map((r: any) => ({
			slug: r.slug,
			name: r.name,
			available: r.available,
		}));
}

/**
 * Add an SSH key to the DigitalOcean account.
 * Returns the key's ID (number) and fingerprint.
 * If the key already exists (same fingerprint), returns the existing one.
 */
export async function addSshKey(
	token: string,
	name: string,
	publicKey: string,
): Promise<{ id: number; fingerprint: string }> {
	// First check if a key with this name/fingerprint already exists
	const listRes = await fetch(`${DO_API}/account/keys?per_page=200`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});

	if (listRes.ok) {
		const listData = await listRes.json();
		const existing = (listData.ssh_keys ?? []).find(
			(k: any) => k.name === name || k.public_key.trim() === publicKey.trim(),
		);
		if (existing) {
			return { id: existing.id, fingerprint: existing.fingerprint };
		}
	}

	// Create new key
	const res = await fetch(`${DO_API}/account/keys`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ name, public_key: publicKey }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to add SSH key to DigitalOcean: ${body}`);
	}

	const data = await res.json();
	return { id: data.ssh_key.id, fingerprint: data.ssh_key.fingerprint };
}

// ── Reserved IPs ──────────────────────────────────────────────

export interface ReservedIpInfo {
	ip: string;
	region: string;
	dropletId: number | null;
}

/**
 * List all reserved IPs on the account.
 */
export async function listReservedIps(token: string): Promise<ReservedIpInfo[]> {
	const res = await fetch(`${DO_API}/reserved_ips?per_page=200`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`DigitalOcean API error (${res.status}): ${body}`);
	}

	const data = await res.json();
	return (data.reserved_ips ?? []).map((r: any) => ({
		ip: r.ip,
		region: r.region?.slug ?? "",
		dropletId: r.droplet?.id ?? null,
	}));
}

/**
 * Create a new reserved IP in the given region.
 */
export async function createReservedIp(token: string, region: string): Promise<string> {
	const res = await fetch(`${DO_API}/reserved_ips`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ region }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to create reserved IP: ${body}`);
	}

	const data = await res.json();
	return data.reserved_ip.ip;
}

/**
 * Assign a reserved IP to a droplet.
 * If the IP is already assigned to this droplet, this is a no-op.
 */
export async function assignReservedIp(token: string, ip: string, dropletId: number): Promise<void> {
	const res = await fetch(`${DO_API}/reserved_ips/${ip}/actions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ type: "assign", droplet_id: dropletId }),
	});

	if (!res.ok) {
		const body = await res.text();
		// "already assigned" is not a real error
		if (body.includes("is already assigned")) return;
		throw new Error(`Failed to assign reserved IP ${ip}: ${body}`);
	}
}

// ── Firewall ──────────────────────────────────────────────────

/**
 * Ensure a cloud firewall exists for the given droplet.
 * Idempotent — if a firewall named `name` already exists and targets the droplet, returns it.
 * Otherwise creates a new one with inbound rules for all Olympus service ports.
 */
export async function ensureFirewall(
	token: string,
	dropletId: number,
	name = "olympusoss-firewall",
): Promise<{ id: string; name: string }> {
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

	// Check for existing firewall
	const listRes = await fetch(`${DO_API}/firewalls?per_page=200`, { headers });
	if (listRes.ok) {
		const listData = await listRes.json();
		const existing = (listData.firewalls ?? []).find(
			(fw: any) => fw.name === name && (fw.droplet_ids ?? []).includes(dropletId),
		);
		if (existing) {
			return { id: existing.id, name: existing.name };
		}
	}

	// Create firewall
	const inbound_rules = OLYMPUS_INBOUND_PORTS.map((ports) => ({
		protocol: "tcp",
		ports,
		sources: { addresses: ["0.0.0.0/0", "::/0"] },
	}));

	const outbound_rules = [
		{ protocol: "tcp", ports: "1-65535", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
		{ protocol: "udp", ports: "1-65535", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
		{ protocol: "icmp", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
	];

	const res = await fetch(`${DO_API}/firewalls`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name, droplet_ids: [dropletId], inbound_rules, outbound_rules }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to create firewall: ${body}`);
	}

	const data = await res.json();
	return { id: data.firewall.id, name: data.firewall.name };
}
