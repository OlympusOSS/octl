import { confirm, input } from "@inquirer/prompts";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

const HOSTINGER_API = "https://api.hostinger.com/api/dns/v1";

interface HostingerRecord {
	type: string;
	name: string;
	content: string;
	ttl: number;
	priority?: number;
}

/**
 * Step 2 — Hostinger DNS: create/update A records + Resend email DNS records.
 *
 * - Prompts for Hostinger API token (or skips for manual setup)
 * - Prompts for Droplet IP if not set by step 3
 * - Creates or updates DNS records via Hostinger API
 * - If no token, prints records for manual setup
 */
export async function run(ctx: SetupContext): Promise<void> {
	// We need a Droplet IP for the A records
	if (!ctx.dropletIp) {
		ctx.dropletIp = await input({
			message: `${ui.cyan("Droplet public IP")} address:`,
			validate: (v) => (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? true : "Enter a valid IPv4 address"),
		});
	}

	// Build the full list of records we need
	const aRecordSubdomains = ["login.ciam", "login.iam", "oauth.ciam", "oauth.iam", "admin.ciam", "admin.iam", "olympus"];

	const allRecords: HostingerRecord[] = aRecordSubdomains.map((sub) => ({
		type: "A",
		name: sub,
		content: ctx.dropletIp,
		ttl: 3600,
	}));

	// Add Resend email DNS records if available
	for (const r of ctx.resendDnsRecords) {
		allRecords.push({
			type: r.type.toUpperCase(),
			name: r.name,
			content: r.value,
			ttl: 3600,
			priority: r.priority,
		});
	}

	// Prompt for Hostinger token
	if (!ctx.hostingerToken) {
		const useApi = await confirm({
			message: `Do you have a ${ui.bold("Hostinger API token")} for automated DNS setup?`,
			default: true,
		});

		if (useApi) {
			ctx.hostingerToken = await input({
				message: `${ui.cyan("Hostinger API token")}:`,
				validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
			});
		}
	}

	if (ctx.hostingerToken) {
		await syncDnsRecords(ctx.domain, ctx.hostingerToken, allRecords);
	} else {
		// Print records for manual setup
		ui.warn("Skipping automated DNS — add these records manually in Hostinger:");
		console.log("");
		ui.table(
			["Type", "Name", "Value", "TTL"],
			allRecords.map((r) => [r.type, r.name, r.content.length > 50 ? `${r.content.substring(0, 47)}...` : r.content, String(r.ttl)]),
		);
		console.log("");
		ui.info(`After adding records, wait for DNS propagation and verify in ${ui.bold("Resend dashboard")}.`);
	}
}

/**
 * Sync DNS records via Hostinger API.
 * For each record: check if it exists → update if different, create if missing.
 */
async function syncDnsRecords(domain: string, token: string, desired: HostingerRecord[]): Promise<void> {
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};

	// Fetch existing records
	const existingRes = await fetch(`${HOSTINGER_API}/zones/${domain}`, { headers });

	if (!existingRes.ok) {
		throw new Error(`Failed to fetch DNS zone for ${domain}: ${existingRes.status} ${await existingRes.text()}`);
	}

	const existingData = await existingRes.json();
	const existingRecords: any[] = existingData.records ?? existingData ?? [];

	for (const record of desired) {
		// Find matching existing record by type + name
		const match = existingRecords.find((e: any) => e.type?.toUpperCase() === record.type && e.name === record.name);

		if (match && (match.content === record.content || match.value === record.content)) {
			ui.skip(`${ui.dim(record.type)} ${ui.bold(record.name)} → already set`);
			continue;
		}

		if (match) {
			// Update existing record
			const updateRes = await fetch(`${HOSTINGER_API}/zones/${domain}`, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					records: [
						{
							type: record.type,
							name: record.name,
							content: record.content,
							ttl: record.ttl,
							...(record.priority !== undefined && { priority: record.priority }),
						},
					],
					overwrite: true,
				}),
			});

			if (!updateRes.ok) {
				ui.error(`Failed to update ${ui.bold(record.type)} ${ui.bold(record.name)}: ${await updateRes.text()}`);
			} else {
				ui.success(`Updated ${ui.cyan(record.type)} ${ui.bold(record.name)} → ${ui.host(record.content)}`);
			}
		} else {
			// Create new record
			const createRes = await fetch(`${HOSTINGER_API}/zones/${domain}`, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					records: [
						{
							type: record.type,
							name: record.name,
							content: record.content,
							ttl: record.ttl,
							...(record.priority !== undefined && { priority: record.priority }),
						},
					],
					overwrite: false,
				}),
			});

			if (!createRes.ok) {
				ui.error(`Failed to create ${ui.bold(record.type)} ${ui.bold(record.name)}: ${await createRes.text()}`);
			} else {
				ui.success(`Created ${ui.cyan(record.type)} ${ui.bold(record.name)} → ${ui.host(record.content)}`);
			}
		}
	}
}
