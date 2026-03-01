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
	let sshKeySource = "";
	if (ctx.sshPrivateKeyPath) {
		try {
			sshKey = readFileSync(ctx.sshPrivateKeyPath, "utf-8");
			sshKeySource = ctx.sshPrivateKeyPath;
			ui.info(`Reading SSH private key from ${ui.cmd(ctx.sshPrivateKeyPath)}`);
		} catch {
			ui.warn(`Could not read SSH key at ${ui.cmd(ctx.sshPrivateKeyPath)}`);
			sshKey = await input({ message: `${ui.cyan("Deploy SSH private key")}:` });
			sshKeySource = "manual input";
		}
	} else {
		const keyInput = await input({ message: `${ui.cyan("Deploy SSH private key")} ${ui.dim("(paste key or path to file)")}:` });
		try {
			sshKey = readFileSync(keyInput, "utf-8");
			sshKeySource = keyInput;
			ui.info(`Reading SSH private key from ${ui.cmd(keyInput)}`);
		} catch {
			// Assume it's the key content itself
			sshKey = keyInput;
			sshKeySource = "pasted content";
		}
	}
	ui.success(`${ui.label("DEPLOY_SSH_KEY")} ${ui.dim("source:")} ${ui.cmd(sshKeySource)}`);

	// Build the complete secrets map
	const secrets: Record<string, string> = {
		// Infrastructure
		DEPLOY_SSH_KEY: sshKey,
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

	for (const [name, value] of Object.entries(secrets)) {
		if (!value) {
			ui.warn(`Skipping ${ui.label(name)} — empty value`);
			continue;
		}
		await github.setSecret(`${ctx.repoOwner}/${ctx.repoName}`, ENV, name, value);
		ui.success(`${ui.label(name)} ${ui.dim("=")} ${ui.magenta(value)}`);
	}

	ui.info(`${ui.bold(String(names.length))} secrets configured`);
}
