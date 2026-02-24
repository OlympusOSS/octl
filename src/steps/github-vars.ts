import { input } from "@inquirer/prompts";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

const ENV = "production";

/**
 * Step 6 — GitHub Variables: compute all URLs from domain and set them.
 *
 * - Derives all domain URLs from ctx.domain
 * - Sets all variables via gh variable set --env production
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

	if (!ctx.ghcrUsername) {
		const username = await github.ensureGhAuth();
		ctx.ghcrUsername = username;
	}

	const domain = ctx.domain;

	// Build variables map
	const variables: Record<string, string> = {
		// Infrastructure
		DEPLOY_PATH: ctx.deployPath,
		DEPLOY_SSH_PORT: String(ctx.sshPort),
		GHCR_USERNAME: ctx.ghcrUsername,

		// Domain URLs
		CIAM_HERA_PUBLIC_URL: `https://login.ciam.${domain}`,
		IAM_HERA_PUBLIC_URL: `https://login.iam.${domain}`,
		CIAM_HYDRA_PUBLIC_URL: `https://oauth.ciam.${domain}`,
		IAM_HYDRA_PUBLIC_URL: `https://oauth.iam.${domain}`,
		CIAM_ATHENA_PUBLIC_URL: `https://admin.ciam.${domain}`,
		IAM_ATHENA_PUBLIC_URL: `https://admin.iam.${domain}`,
		DEMO_PUBLIC_URL: `https://olympus.${domain}`,

		// Email
		SMTP_FROM_EMAIL: `noreply@${domain}`,

		// OAuth2 client IDs
		ATHENA_CIAM_OAUTH_CLIENT_ID: "athena-ciam-client",
		ATHENA_IAM_OAUTH_CLIENT_ID: "athena-iam-client",

		// Admin
		ADMIN_EMAIL: ctx.adminEmail || `admin@${domain}`,

		// Image tags
		HERA_IMAGE_TAG: "latest",
		ATHENA_IMAGE_TAG: "latest",
		DEMO_IMAGE_TAG: "latest",
	};

	// Add demo client IDs if included
	if (ctx.includeDemo) {
		variables.DEMO_CIAM_CLIENT_ID = "demo-ciam-client";
		variables.DEMO_IAM_CLIENT_ID = "demo-iam-client";
	}

	// Set all variables
	const names = Object.keys(variables);
	ui.info(`Setting ${ui.bold(String(names.length))} variables on ${ui.label(ENV)} environment...`);

	for (const [name, value] of Object.entries(variables)) {
		await github.setVariable(ENV, name, value);
		ui.success(`${ui.label(name)} ${ui.dim("=")} ${ui.green(value)}`);
	}

	ui.info(`${ui.bold(String(names.length))} variables configured`);
}
