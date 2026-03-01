import { input } from "@inquirer/prompts";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

/**
 * Step 6 — GitHub Variables: compute all URLs from domain and set them
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

	if (!ctx.ghcrUsername) {
		const username = await github.ensureGhAuth();
		ctx.ghcrUsername = username;
		ui.success(`GHCR username: ${ui.bold(username)}`);
	}

	const domain = ctx.domain;

	const variables: Record<string, string> = {
		DEPLOY_SERVER_IP: ctx.dropletIp,
		DEPLOY_USER: ctx.sshUser || "root",
		DEPLOY_PATH: ctx.deployPath,
		DEPLOY_SSH_PORT: String(ctx.sshPort),
		GHCR_USERNAME: ctx.ghcrUsername,
		CIAM_HERA_PUBLIC_URL: `https://login.ciam.${domain}`,
		IAM_HERA_PUBLIC_URL: `https://login.iam.${domain}`,
		CIAM_HYDRA_PUBLIC_URL: `https://oauth.ciam.${domain}`,
		IAM_HYDRA_PUBLIC_URL: `https://oauth.iam.${domain}`,
		CIAM_ATHENA_PUBLIC_URL: `https://admin.ciam.${domain}`,
		IAM_ATHENA_PUBLIC_URL: `https://admin.iam.${domain}`,
		SITE_PUBLIC_URL: `https://olympus.${domain}`,
		PGADMIN_PUBLIC_URL: `https://pgadmin.${domain}`,
		SMTP_FROM_EMAIL: `noreply@${domain}`,
		ATHENA_CIAM_OAUTH_CLIENT_ID: "athena-ciam-client",
		ATHENA_IAM_OAUTH_CLIENT_ID: "athena-iam-client",
		PGADMIN_OAUTH_CLIENT_ID: "pgadmin",
		ADMIN_EMAIL: ctx.adminEmail || `admin@${domain}`,
		HERA_IMAGE_TAG: "latest",
		ATHENA_IMAGE_TAG: "latest",
		SITE_IMAGE_TAG: "latest",
	};

	if (ctx.includeSite) {
		variables.SITE_CIAM_CLIENT_ID = "site-ciam-client";
		variables.SITE_IAM_CLIENT_ID = "site-iam-client";
	}

	ctx.githubVariables = variables;

	const names = Object.keys(variables);
	ui.info(`Setting ${ui.bold(String(names.length))} variables on org ${ui.label(ctx.repoOwner)}...`);

	for (const [name, value] of Object.entries(variables)) {
		await github.setOrgVariable(ctx.repoOwner, name, value);
		ui.success(`${ui.label(name)} ${ui.dim("=")} ${ui.green(value)}`);
	}

	ui.info(`${ui.bold(String(names.length))} variables configured on org ${ui.label(ctx.repoOwner)}`);
}
