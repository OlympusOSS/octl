const DO_API = "https://api.digitalocean.com/v2";

interface DropletNetwork {
	ip_address: string;
	type: "public" | "private";
}

interface Droplet {
	id: number;
	name: string;
	networks: { v4: DropletNetwork[] };
}

/**
 * Look up a Droplet's public IPv4 by name using the DigitalOcean REST API.
 * Throws if the Droplet is not found or has no public IP.
 */
export async function lookupDropletIp(token: string, name: string): Promise<string> {
	const res = await fetch(`${DO_API}/droplets?per_page=200`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`DigitalOcean API error (${res.status}): ${body}`);
	}

	const data: { droplets: Droplet[] } = await res.json();
	const droplet = data.droplets.find((d) => d.name === name);

	if (!droplet) {
		const available = data.droplets.map((d) => d.name).join(", ");
		throw new Error(`Droplet "${name}" not found. Available: ${available || "(none)"}`);
	}

	const publicIp = droplet.networks.v4.find((n) => n.type === "public")?.ip_address;

	if (!publicIp) {
		throw new Error(`Droplet "${name}" has no public IPv4 address`);
	}

	return publicIp;
}
