import { checkbox, confirm, input } from "@inquirer/prompts";
import { saveSettings } from "../lib/settings.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

interface DestroyableResource {
	id: string;
	label: string;
	description: string;
	available: boolean;
	destroy: () => Promise<void>;
}

/**
 * Prod destroy command — list resources created by octl and offer to tear them down.
 */
export async function run(ctx: SetupContext): Promise<void> {
	// Ensure we have a DO token if we have DO resources to destroy
	if (ctx.reservedIp && !ctx.doToken) {
		ctx.doToken = await input({
			message: `${ui.cyan("DigitalOcean API token")} ${ui.dim("(needed to destroy resources)")}:`,
			validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
		});
		saveSettings(ctx, true);
	}

	const resources: DestroyableResource[] = [
		{
			id: "reserved-ip",
			label: "Reserved IP",
			description: ctx.reservedIp ? `${ctx.reservedIp} (DigitalOcean)` : "none",
			available: !!ctx.reservedIp,
			destroy: async () => {
				if (!ctx.doToken) throw new Error("DigitalOcean token required");

				// Unassign first if attached to a droplet, then delete
				ui.info(`Releasing reserved IP ${ui.host(ctx.reservedIp)}...`);

				const res = await fetch(`https://api.digitalocean.com/v2/reserved_ips/${ctx.reservedIp}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${ctx.doToken}` },
				});

				if (!res.ok && res.status !== 404) {
					const body = await res.text();
					throw new Error(`Failed to release reserved IP: ${res.status} ${body}`);
				}

				ctx.reservedIp = "";
				// If the droplet IP was the reserved IP, clear it too
				if (ctx.dropletIp === ctx.reservedIp) {
					ctx.dropletIp = "";
				}
				saveSettings(ctx, true);
				ui.success("Reserved IP released");
			},
		},
	];

	const available = resources.filter((r) => r.available);

	if (available.length === 0) {
		ui.info("No destroyable resources found in saved context.");
		ui.info(`Resources are tracked in ${ui.cmd("octl.json")} after deployment.`);
		return;
	}

	const selectedIds = await checkbox<string>({
		message: "Select resources to destroy:",
		choices: available.map((r) => ({
			name: `${ui.bold(r.label)} ${ui.dim("—")} ${ui.dim(r.description)}`,
			value: r.id,
		})),
	});

	if (selectedIds.length === 0) {
		ui.info("Nothing selected.");
		return;
	}

	const selected = available.filter((r) => selectedIds.includes(r.id));

	console.log("");
	ui.warn(ui.bold("You are about to destroy:"));
	for (const r of selected) {
		ui.keyValue(`  ${r.label}`, r.description);
	}
	console.log("");

	const proceed = await confirm({
		message: `Destroy ${selected.length} resource(s)? This cannot be undone.`,
		default: false,
	});

	if (!proceed) {
		ui.info("Cancelled.");
		return;
	}

	for (const r of selected) {
		try {
			await r.destroy();
		} catch (err: unknown) {
			ui.error(`Failed to destroy ${r.label}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	saveSettings(ctx);
}
