import { readFileSync } from "node:fs";
import { input } from "@inquirer/prompts";
import { deriveAllSecrets } from "../lib/crypto.js";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

const ENV = "production";

/**
 * Step 5 — GitHub Secrets: derive all secrets from passphrase and set them.
 *
 * - Derives deterministic secrets via PBKDF2
 * - Prompts for external keys not derivable (Resend, GHCR PAT, SSH key)
 * - Sets all secrets via gh secret set --env production
 */
export async function run(ctx: SetupContext): Promise<void> {
	// Ensure we have repo info
	if (!ctx.repoOwner || !ctx.repoName) {
		const detected = await github.detectRepo();
		if (detected) {
			ctx.repoOwner = detected.owner;
			ctx.repoName = detected.name;
		} else {
			const slug = await input({
				message: `${ui.cyan("GitHub repo")} ${ui.dim("(owner/name)")}:`,
				validate: (v) => (v.includes("/") ? true : "Format: owner/name"),
			});
			const [owner, name] = slug.split("/");
			ctx.repoOwner = owner;
			ctx.repoName = name;
		}
	}

	// Derive all crypto secrets from passphrase
	ui.info(`Deriving secrets from passphrase ${ui.dim("(PBKDF2, 600k iterations)")}...`);
	const derived = deriveAllSecrets(ctx.passphrase, ctx.includeSite);
	ui.success(`Derived ${ui.bold(String(Object.keys(derived).length))} secrets`);

	// Print derived secrets
	for (const [name, value] of Object.entries(derived)) {
		ui.success(`${ui.label(name)} ${ui.dim("=")} ${ui.magenta(value)}`);
	}

	// Read SSH private key if available
	let sshKey = "";
	if (ctx.sshPrivateKeyPath) {
		try {
			sshKey = readFileSync(ctx.sshPrivateKeyPath, "utf-8");
		} catch {
			ui.warn(`Could not read SSH key at ${ui.cmd(ctx.sshPrivateKeyPath)}`);
			sshKey = await input({ message: `${ui.cyan("Deploy SSH private key")}:` });
		}
	} else {
		sshKey = await input({ message: `${ui.cyan("Deploy SSH private key")} ${ui.dim("(paste key or path to file)")}:` });
		try {
			sshKey = readFileSync(sshKey, "utf-8");
		} catch {
			// Assume it's the key content itself
		}
	}

	// Build the complete secrets map
	const secrets: Record<string, string> = {
		// Infrastructure
		DEPLOY_SSH_KEY: sshKey,
		DEPLOY_USER: ctx.sshUser || "root",
		DEPLOY_SERVER_IP: ctx.dropletIp,
		GHCR_PAT: ctx.ghcrPat,

		// Neon database connection strings
		NEON_CIAM_KRATOS_DSN: ctx.neonDsns.ciamKratos,
		NEON_CIAM_HYDRA_DSN: ctx.neonDsns.ciamHydra,
		NEON_IAM_KRATOS_DSN: ctx.neonDsns.iamKratos,
		NEON_IAM_HYDRA_DSN: ctx.neonDsns.iamHydra,

		// Derived secrets
		...derived,

		// SMTP
		RESEND_API_KEY: ctx.resendApiKey,

		// Admin
		ADMIN_PASSWORD: ctx.adminPassword,
	};

	// Save the full secrets map to ctx so it persists in octl.json
	ctx.githubSecrets = secrets;

	// Set all secrets
	const names = Object.keys(secrets);
	ui.info(`Setting ${ui.bold(String(names.length))} secrets on ${ui.label(ENV)} environment...`);

	// Keys that contain sensitive multi-line or credential data — show truncated
	const masked = new Set(["DEPLOY_SSH_KEY", "GHCR_PAT", "RESEND_API_KEY", "ADMIN_PASSWORD"]);
	const dsnKeys = new Set(["NEON_CIAM_KRATOS_DSN", "NEON_CIAM_HYDRA_DSN", "NEON_IAM_KRATOS_DSN", "NEON_IAM_HYDRA_DSN"]);

	for (const [name, value] of Object.entries(secrets)) {
		if (!value) {
			ui.warn(`Skipping ${ui.label(name)} — empty value`);
			continue;
		}
		await github.setSecret(ENV, name, value);

		let display: string;
		if (masked.has(name)) {
			display = ui.dim(`${value.slice(0, 8)}...`);
		} else if (dsnKeys.has(name)) {
			// Show host portion only, mask credentials
			const match = value.match(/@([^/]+)\//);
			display = ui.dim(match ? `***@${match[1]}/***` : "***");
		} else {
			display = ui.magenta(value);
		}
		ui.success(`${ui.label(name)} ${ui.dim("=")} ${display}`);
	}

	ui.info(`${ui.bold(String(names.length))} secrets configured`);
}
