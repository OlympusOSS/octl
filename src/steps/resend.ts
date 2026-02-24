import { input } from "@inquirer/prompts";
import type { DnsRecord, SetupContext } from "../types.js";
import * as ui from "../lib/ui.js";

const RESEND_API = "https://api.resend.com";

/**
 * Step 1 — Resend: add domain and retrieve DNS records.
 *
 * - Prompts for API key if not already set
 * - Adds domain via Resend API (idempotent — skips if exists)
 * - Stores DNS records on context for Hostinger step
 */
export async function run(ctx: SetupContext): Promise<void> {
	// Prompt for API key if not provided by a prior step
	if (!ctx.resendApiKey) {
		ui.info(`Create an API key at: ${ui.url("https://resend.com/api-keys")}`);
		ctx.resendApiKey = await input({
			message: `${ui.cyan("Resend API key")} ${ui.dim("(starts with re_)")}:`,
			validate: (v) => (v.startsWith("re_") ? true : "API key must start with re_"),
		});
	}

	const headers = {
		Authorization: `Bearer ${ctx.resendApiKey}`,
		"Content-Type": "application/json",
	};

	// Check if domain already exists
	const existingDomains = await fetch(`${RESEND_API}/domains`, { headers }).then((r) => r.json());

	const existing = (existingDomains.data ?? []).find((d: any) => d.name === ctx.domain);

	let domainData: any;

	if (existing) {
		ui.skip(`Domain ${ui.host(ctx.domain)} already exists in Resend`);
		// Fetch the domain details to get DNS records
		domainData = await fetch(`${RESEND_API}/domains/${existing.id}`, { headers }).then((r) => r.json());
	} else {
		// Create the domain
		const createRes = await fetch(`${RESEND_API}/domains`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: ctx.domain }),
		});

		if (!createRes.ok) {
			const err = await createRes.text();
			throw new Error(`Failed to add domain to Resend: ${err}`);
		}

		domainData = await createRes.json();
		ui.success(`Added domain ${ui.host(ctx.domain)} to Resend`);
	}

	// Extract DNS records from the response
	const records: DnsRecord[] = [];

	if (domainData.records) {
		for (const r of domainData.records) {
			records.push({
				type: r.record_type ?? r.type,
				name: r.name,
				value: r.value,
				priority: r.priority,
				ttl: r.ttl,
			});
		}
	}

	ctx.resendDnsRecords = records;

	if (records.length > 0) {
		ui.info("DNS records to add (will be used in Hostinger step):");
		ui.table(
			["Type", "Name", "Value"],
			records.map((r) => [r.type, r.name, r.value.length > 60 ? `${r.value.substring(0, 57)}...` : r.value]),
		);
	}

	// Check verification status
	const status = domainData.status ?? existing?.status;
	if (status === "verified") {
		ui.success(`Domain ${ui.host(ctx.domain)} is already verified`);
	} else {
		ui.warn(`Domain is not yet verified — add DNS records and click ${ui.bold("Verify")} in Resend dashboard`);
	}
}
