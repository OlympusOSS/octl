import { readFileSync } from "node:fs";
import { input, password } from "@inquirer/prompts";
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
	const derived = deriveAllSecrets(ctx.passphrase, ctx.includeDemo);
	ui.success(`Derived ${ui.bold(String(Object.keys(derived).length))} secrets`);

	// Collect externally-provided secrets
	if (!ctx.resendApiKey) {
		ui.info(`Create an API key at: ${ui.url("https://resend.com/api-keys")}`);
		ctx.resendApiKey = await input({
			message: `${ui.cyan("Resend API key")} ${ui.dim("(starts with re_)")}:`,
			validate: (v) => (v.startsWith("re_") ? true : "API key must start with re_"),
		});
	}

	if (!ctx.ghcrPat) {
		ui.info(`Create a PAT at: ${ui.url("https://github.com/settings/tokens")} — scope: ${ui.bold("read:packages")}`);
		ctx.ghcrPat = await password({
			message: `${ui.cyan("GitHub PAT")} ${ui.dim("(read:packages)")}:`,
			validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
		});
	}

	if (!ctx.adminPassword) {
		ctx.adminPassword = await password({
			message: `${ui.cyan("Admin password")} ${ui.dim("(for initial admin identity)")}:`,
			validate: (v) => (v.length >= 8 ? true : "Password must be at least 8 characters"),
		});
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

		// Derived secrets
		...derived,

		// SMTP
		RESEND_API_KEY: ctx.resendApiKey,

		// Admin
		ADMIN_PASSWORD: ctx.adminPassword,
	};

	// Set all secrets
	const names = Object.keys(secrets);
	ui.info(`Setting ${ui.bold(String(names.length))} secrets on ${ui.label(ENV)} environment...`);

	for (const [name, value] of Object.entries(secrets)) {
		if (!value) {
			ui.warn(`Skipping ${ui.label(name)} — empty value`);
			continue;
		}
		await github.setSecret(ENV, name, value);
		ui.success(ui.label(name));
	}

	ui.info(`${ui.bold(String(names.length))} secrets configured`);
}
