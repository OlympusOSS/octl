import { readFileSync } from "node:fs";
import { input } from "@inquirer/prompts";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

const ENV = "production";
const APP_REPOS = ["athena", "hera", "site"];

/**
 * Step 7 — App Deploy Secrets: set deployment secrets & variables on app repos.
 *
 * Each app repo (athena, hera, site) needs SSH + GHCR credentials and
 * server connection details to deploy independently after CI builds.
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

	// Ensure we have the SSH key
	let sshKey = "";
	if (ctx.sshPrivateKeyPath) {
		try {
			sshKey = readFileSync(ctx.sshPrivateKeyPath, "utf-8");
		} catch {
			ui.warn(`Could not read SSH key at ${ui.cmd(ctx.sshPrivateKeyPath)}`);
		}
	}
	if (!sshKey && ctx.githubSecrets?.DEPLOY_SSH_KEY) {
		sshKey = ctx.githubSecrets.DEPLOY_SSH_KEY;
	}
	if (!sshKey) {
		throw new Error("No SSH key available. Run the Droplet and GitHub Secrets steps first.");
	}

	// Ensure we have GHCR PAT
	if (!ctx.ghcrPat) {
		ui.info(`Create a PAT at: ${ui.url("https://github.com/settings/tokens")} — scope: ${ui.bold("read:packages")}`);
		ctx.ghcrPat = await input({
			message: `${ui.cyan("GitHub PAT")} ${ui.dim("(read:packages)")}:`,
			validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
		});
	}

	if (!ctx.ghcrUsername) {
		ctx.ghcrUsername = await github.ensureGhAuth();
	}

	if (!ctx.dropletIp) {
		throw new Error("No Droplet IP available. Run the Droplet step first.");
	}

	const secrets: Record<string, string> = {
		DEPLOY_SSH_KEY: sshKey,
		GHCR_PAT: ctx.ghcrPat,
	};

	const variables: Record<string, string> = {
		DEPLOY_SERVER_IP: ctx.dropletIp,
		DEPLOY_SSH_PORT: String(ctx.sshPort || 22),
		DEPLOY_USER: ctx.sshUser || "root",
		DEPLOY_PATH: ctx.deployPath || "/opt/olympusoss/prod",
		GHCR_USERNAME: ctx.ghcrUsername,
	};

	for (const repo of APP_REPOS) {
		const fullRepo = `${ctx.repoOwner}/${repo}`;
		ui.info(`\nConfiguring ${ui.bold(fullRepo)}...`);

		// Create production environment (idempotent via PUT)
		const ok = await github.createEnvironment(ctx.repoOwner, repo, ENV);
		if (ok) {
			ui.success(`Environment ${ui.label(ENV)} ready`);
		} else {
			ui.warn(`Could not create environment on ${fullRepo} — it may require admin access`);
		}

		// Set secrets
		for (const [name, value] of Object.entries(secrets)) {
			await github.setSecret(fullRepo, ENV, name, value);
			ui.success(`${ui.label(name)} set`);
		}

		// Set variables
		for (const [name, value] of Object.entries(variables)) {
			await github.setVariable(fullRepo, ENV, name, value);
			ui.success(`${ui.label(name)} ${ui.dim("=")} ${ui.green(value)}`);
		}
	}

	ui.info(`\nDeployment credentials configured on ${ui.bold(String(APP_REPOS.length))} app repos`);
}
