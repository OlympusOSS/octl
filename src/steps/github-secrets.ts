import { readFileSync } from "node:fs";
import { input } from "@inquirer/prompts";
import { deriveAllSecrets } from "../lib/crypto.js";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

/**
 * Step 5 — GitHub Secrets: derive all secrets from passphrase and set them
 * at the organization level (visible to all repos in the org).
 */
export async function run(ctx: SetupContext): Promise<void> {
	if (!ctx.repoOwner) {
		const detected = await github.detectRepo();
		if (detected) {
			ctx.repoOwner = detected.owner;
		} else {
			ctx.repoOwner = await input({
				message: `${ui.cyan("GitHub org")} ${ui.dim("(e.g. OlympusOSS)")}:`,
				validate: (v) => (v.length > 0 ? true : "Cannot be empty"),
			});
		}
	}

	// Derive all crypto secrets from passphrase
	ui.info(`Deriving secrets from passphrase ${ui.dim("(PBKDF2, 600k iterations)")}...`);
	const derived = deriveAllSecrets(ctx.passphrase, ctx.includeSite);
	ui.success(`Derived ${ui.bold(String(Object.keys(derived).length))} secrets`);

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
			sshKey = keyInput;
			sshKeySource = "pasted content";
		}
	}
	ui.success(`${ui.label("DEPLOY_SSH_KEY")} ${ui.dim("source:")} ${ui.cmd(sshKeySource)}`);

	// Build the complete secrets map
	const secrets: Record<string, string> = {
		DEPLOY_SSH_KEY: sshKey,
		GHCR_PAT: ctx.ghcrPat,
		NEON_CIAM_KRATOS_DSN: ctx.neonDsns.ciamKratos,
		NEON_CIAM_HYDRA_DSN: ctx.neonDsns.ciamHydra,
		NEON_IAM_KRATOS_DSN: ctx.neonDsns.iamKratos,
		NEON_IAM_HYDRA_DSN: ctx.neonDsns.iamHydra,
		...derived,
		RESEND_API_KEY: ctx.resendApiKey,
		ADMIN_PASSWORD: ctx.adminPassword,
	};

	ctx.githubSecrets = secrets;

	const names = Object.keys(secrets);
	ui.info(`Setting ${ui.bold(String(names.length))} secrets on org ${ui.label(ctx.repoOwner)}...`);

	for (const [name, value] of Object.entries(secrets)) {
		if (!value) {
			ui.warn(`Skipping ${ui.label(name)} — empty value`);
			continue;
		}
		await github.setOrgSecret(ctx.repoOwner, name, value);
		ui.success(`${ui.label(name)} ${ui.dim("=")} ${ui.magenta(value)}`);
	}

	ui.info(`${ui.bold(String(names.length))} secrets configured on org ${ui.label(ctx.repoOwner)}`);
}
