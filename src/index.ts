#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { checkbox, confirm, input, password } from "@inquirer/prompts";
import * as ui from "./lib/ui.js";
import { commandExists, installHint } from "./lib/shell.js";
import { type SetupContext, type StepId, createEmptyContext } from "./types.js";
import { deriveAllSecrets } from "./lib/crypto.js";

// Step modules
import * as resendStep from "./steps/resend.js";
import * as hostingerStep from "./steps/hostinger.js";
import * as dropletStep from "./steps/droplet.js";
import * as githubEnvStep from "./steps/github-env.js";
import * as githubSecretsStep from "./steps/github-secrets.js";
import * as githubVarsStep from "./steps/github-vars.js";
import * as deployStep from "./steps/deploy.js";

interface Step {
	id: StepId;
	label: string;
	description: string;
	run: (ctx: SetupContext) => Promise<void>;
	/** Which common inputs this step requires. */
	needs: ("domain" | "passphrase" | "adminPassword" | "includeDemo")[];
}

const STEPS: Step[] = [
	{
		id: "resend",
		label: "Resend",
		description: "Email provider — add domain + get DNS records",
		run: resendStep.run,
		needs: ["domain"],
	},
	{
		id: "hostinger",
		label: "Hostinger",
		description: "DNS records — A records + email DNS",
		run: hostingerStep.run,
		needs: ["domain"],
	},
	{
		id: "droplet",
		label: "DigitalOcean",
		description: "Droplet — create or connect + SSH setup",
		run: dropletStep.run,
		needs: [],
	},
	{
		id: "github-env",
		label: "GitHub Environment",
		description: "Create production environment",
		run: githubEnvStep.run,
		needs: [],
	},
	{
		id: "github-secrets",
		label: "GitHub Secrets",
		description: "Derive + set all secrets",
		run: githubSecretsStep.run,
		needs: ["domain", "passphrase", "adminPassword", "includeDemo"],
	},
	{
		id: "github-vars",
		label: "GitHub Variables",
		description: "Compute + set all variables",
		run: githubVarsStep.run,
		needs: ["domain", "includeDemo"],
	},
	{
		id: "deploy",
		label: "Deploy",
		description: "Trigger deploy workflow",
		run: deployStep.run,
		needs: [],
	},
];

function setupEscapeHandler(): void {
	// Enable keypress events on stdin so we can detect Escape
	emitKeypressEvents(process.stdin);

	process.stdin.on("keypress", (_ch: string, key: { name: string }) => {
		if (key?.name === "escape") {
			console.log("\n");
			ui.info("Setup cancelled.");
			process.exit(0);
		}
	});
}

async function main(): Promise<void> {
	ui.banner();

	// Allow Escape key to exit at any point
	setupEscapeHandler();

	// Check prerequisites
	await checkPrerequisites();

	// Step selection
	const selectedIds = await checkbox<StepId>({
		message: "Which steps do you want to run?",
		choices: STEPS.map((s, i) => ({
			name: `${ui.cyan(`${i + 1}.`)} ${ui.bold(s.label)} ${ui.dim("—")} ${ui.dim(s.description)}`,
			value: s.id,
			checked: false,
		})),
		required: true,
	});

	const ctx = createEmptyContext();
	ctx.selectedSteps = selectedIds;

	const selectedSteps = STEPS.filter((s) => selectedIds.includes(s.id));

	// Collect common inputs upfront (only what selected steps need)
	const allNeeds = new Set(selectedSteps.flatMap((s) => s.needs));

	if (allNeeds.has("domain")) {
		ctx.domain = await input({
			message: `${ui.cyan("Domain name")} ${ui.dim("(e.g. example.com)")}:`,
			validate: (v) => (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? true : "Enter a valid domain name"),
		});
		ctx.adminEmail = `admin@${ctx.domain}`;
	}

	if (allNeeds.has("passphrase")) {
		ctx.passphrase = await password({
			message: `${ui.cyan("Passphrase")} ${ui.dim("(used to derive all secrets — remember this!)")}:`,
			validate: (v) => (v.length >= 8 ? true : "Passphrase must be at least 8 characters"),
		});

		// Confirm passphrase
		const confirm2 = await password({ message: `${ui.cyan("Confirm passphrase")}:` });
		if (confirm2 !== ctx.passphrase) {
			ui.error("Passphrases do not match. Exiting.");
			process.exit(1);
		}
	}

	if (allNeeds.has("adminPassword")) {
		ctx.adminPassword = await password({
			message: `${ui.cyan("Admin password")} ${ui.dim("(for initial IAM admin identity)")}:`,
			validate: (v) => (v.length >= 8 ? true : "Password must be at least 8 characters"),
		});
	}

	if (allNeeds.has("includeDemo")) {
		ctx.includeDemo = await confirm({
			message: `Include ${ui.bold("demo app")}?`,
			default: false,
		});
	}

	// Run selected steps
	const total = selectedSteps.length;
	for (let i = 0; i < selectedSteps.length; i++) {
		const step = selectedSteps[i];
		ui.stepHeader(i + 1, total, step.label);

		let succeeded = false;
		while (!succeeded) {
			try {
				await step.run(ctx);
				succeeded = true;
			} catch (err: any) {
				ui.error(`Step "${ui.bold(step.label)}" failed: ${err.message}`);

				const retry = await confirm({
					message: "Would you like to retry this step?",
					default: true,
				});

				if (retry) {
					ui.info(`Retrying ${ui.bold(step.label)}…`);
					continue;
				}

				const cont = await confirm({
					message: "Would you like to continue with the remaining steps?",
					default: true,
				});

				if (!cont) {
					ui.info(
						`Exiting. You can re-run ${ui.cmd("octl")} and select only the remaining steps.`,
					);
					process.exit(1);
				}

				break;
			}
		}
	}

	// Save settings to file
	saveSettings(ctx);

	// Summary
	ui.summaryBox("Setup Complete");
	if (ctx.domain) ui.keyValue("Domain", ctx.domain);
	if (ctx.dropletIp) ui.keyValue("Droplet IP", ctx.dropletIp);
	if (ctx.repoOwner) ui.keyValue("Repo", `${ctx.repoOwner}/${ctx.repoName}`);
	if (ctx.adminEmail) ui.keyValue("Admin email", ctx.adminEmail);
	console.log("");

	if (ctx.resendDnsRecords.length > 0 && !ctx.hostingerToken) {
		ui.warn("Don't forget to add Resend DNS records manually in Hostinger!");
	}
}

function getSettingsDir(): string {
	// macOS/Windows have Documents; Linux uses a hidden dotfolder in home
	if (process.platform === "linux") {
		return join(homedir(), ".octl");
	}
	return join(homedir(), "Documents", "octl");
}

function saveSettings(ctx: SetupContext): void {
	const octlDir = getSettingsDir();
	const filePath = join(octlDir, "octl.md");

	if (!existsSync(octlDir)) {
		mkdirSync(octlDir, { recursive: true });
	}

	const timestamp = new Date().toISOString();
	const domain = ctx.domain;
	const repo = ctx.repoOwner && ctx.repoName ? `${ctx.repoOwner}/${ctx.repoName}` : "";
	const ghSecretsUrl = repo ? `https://github.com/${repo}/settings/secrets/actions` : "";
	const ghVarsUrl = repo ? `https://github.com/${repo}/settings/variables/actions` : "";

	// Derive all secrets so we can display them grouped by destination
	const derived = ctx.passphrase ? deriveAllSecrets(ctx.passphrase, ctx.includeDemo) : {};

	// Compute domain URLs
	const domainUrls: Record<string, string> = {};
	if (domain) {
		domainUrls.CIAM_HERA_PUBLIC_URL = `https://login.ciam.${domain}`;
		domainUrls.IAM_HERA_PUBLIC_URL = `https://login.iam.${domain}`;
		domainUrls.CIAM_HYDRA_PUBLIC_URL = `https://oauth.ciam.${domain}`;
		domainUrls.IAM_HYDRA_PUBLIC_URL = `https://oauth.iam.${domain}`;
		domainUrls.CIAM_ATHENA_PUBLIC_URL = `https://admin.ciam.${domain}`;
		domainUrls.IAM_ATHENA_PUBLIC_URL = `https://admin.iam.${domain}`;
		domainUrls.DEMO_PUBLIC_URL = `https://olympus.${domain}`;
	}

	const lines: string[] = [
		"# Olympus CLI — Setup Reference",
		"",
		`> Generated: ${timestamp}`,
		`> Domain: ${domain || "N/A"}`,
		`> Steps run: ${ctx.selectedSteps.join(", ") || "none"}`,
		"",
		"This file lists every value octl collected or derived, organized by **where it needs to be inserted**. Follow each section in order.",
		"",
	];

	// ─── 1. Hostinger DNS ───────────────────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 1. Hostinger DNS",
		"",
		"> https://hpanel.hostinger.com → Domains → your domain → DNS / Nameservers → DNS Records",
		"",
		"Add each row as a DNS record. For A records, the name is the subdomain.",
		"",
	);

	if (domain && ctx.dropletIp) {
		lines.push("### A Records", "");
		lines.push("| Type | Name | Value | TTL |");
		lines.push("|------|------|-------|-----|");
		for (const sub of ["login.ciam", "login.iam", "oauth.ciam", "oauth.iam", "admin.ciam", "admin.iam", "olympus"]) {
			lines.push(`| A | \`${sub}\` | \`${ctx.dropletIp}\` | 3600 |`);
		}
		lines.push("");
	}

	if (ctx.resendDnsRecords.length > 0) {
		lines.push("### Resend Email DNS Records", "");
		lines.push("| Type | Name | Value |");
		lines.push("|------|------|-------|");
		for (const r of ctx.resendDnsRecords) {
			lines.push(`| ${r.type} | \`${r.name}\` | \`${r.value}\` |`);
		}
		lines.push("");
	}

	if (!ctx.dropletIp && ctx.resendDnsRecords.length === 0) {
		lines.push("*No DNS records to add (Hostinger/DNS steps were not run).*", "");
	}

	// ─── 2. GitHub Environment ──────────────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 2. GitHub Environment",
		"",
	);

	if (repo) {
		lines.push(`> https://github.com/${repo}/settings/environments`);
	}

	lines.push(
		"",
		'Create a `production` environment: **Settings → Environments → New environment** → name it `production`.',
		"",
	);

	// ─── 3. GitHub Environment Secrets ───────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 3. GitHub Environment Secrets",
		"",
	);

	if (ghSecretsUrl) {
		lines.push(`> ${ghSecretsUrl}`);
	}

	lines.push(
		"",
		"Set each secret under **Settings → Environments → production → Environment secrets**.",
		"",
		"| Secret | Value |",
		"|--------|-------|",
	);

	// Infrastructure secrets
	if (ctx.sshPrivateKeyPath) {
		lines.push(`| \`DEPLOY_SSH_KEY\` | *(contents of \`${ctx.sshPrivateKeyPath}\`)* |`);
	}
	lines.push(`| \`DEPLOY_USER\` | \`${ctx.sshUser || "root"}\` |`);
	if (ctx.dropletIp) {
		lines.push(`| \`DEPLOY_SERVER_IP\` | \`${ctx.dropletIp}\` |`);
	}
	if (ctx.ghcrPat) {
		lines.push(`| \`GHCR_PAT\` | \`${ctx.ghcrPat}\` |`);
	}

	// Derived secrets
	if (derived.POSTGRES_PASSWORD) {
		lines.push(`| \`POSTGRES_PASSWORD\` | \`${derived.POSTGRES_PASSWORD}\` |`);
	}
	if (derived.CIAM_KRATOS_SECRET_COOKIE) {
		lines.push(`| \`CIAM_KRATOS_SECRET_COOKIE\` | \`${derived.CIAM_KRATOS_SECRET_COOKIE}\` |`);
	}
	if (derived.CIAM_KRATOS_SECRET_CIPHER) {
		lines.push(`| \`CIAM_KRATOS_SECRET_CIPHER\` | \`${derived.CIAM_KRATOS_SECRET_CIPHER}\` |`);
	}
	if (derived.IAM_KRATOS_SECRET_COOKIE) {
		lines.push(`| \`IAM_KRATOS_SECRET_COOKIE\` | \`${derived.IAM_KRATOS_SECRET_COOKIE}\` |`);
	}
	if (derived.IAM_KRATOS_SECRET_CIPHER) {
		lines.push(`| \`IAM_KRATOS_SECRET_CIPHER\` | \`${derived.IAM_KRATOS_SECRET_CIPHER}\` |`);
	}
	if (derived.CIAM_HYDRA_SECRET_SYSTEM) {
		lines.push(`| \`CIAM_HYDRA_SECRET_SYSTEM\` | \`${derived.CIAM_HYDRA_SECRET_SYSTEM}\` |`);
	}
	if (derived.CIAM_HYDRA_PAIRWISE_SALT) {
		lines.push(`| \`CIAM_HYDRA_PAIRWISE_SALT\` | \`${derived.CIAM_HYDRA_PAIRWISE_SALT}\` |`);
	}
	if (derived.IAM_HYDRA_SECRET_SYSTEM) {
		lines.push(`| \`IAM_HYDRA_SECRET_SYSTEM\` | \`${derived.IAM_HYDRA_SECRET_SYSTEM}\` |`);
	}
	if (derived.IAM_HYDRA_PAIRWISE_SALT) {
		lines.push(`| \`IAM_HYDRA_PAIRWISE_SALT\` | \`${derived.IAM_HYDRA_PAIRWISE_SALT}\` |`);
	}
	if (ctx.resendApiKey) {
		lines.push(`| \`RESEND_API_KEY\` | \`${ctx.resendApiKey}\` |`);
	}
	if (derived.ATHENA_CIAM_OAUTH_CLIENT_SECRET) {
		lines.push(`| \`ATHENA_CIAM_OAUTH_CLIENT_SECRET\` | \`${derived.ATHENA_CIAM_OAUTH_CLIENT_SECRET}\` |`);
	}
	if (derived.ATHENA_IAM_OAUTH_CLIENT_SECRET) {
		lines.push(`| \`ATHENA_IAM_OAUTH_CLIENT_SECRET\` | \`${derived.ATHENA_IAM_OAUTH_CLIENT_SECRET}\` |`);
	}
	if (derived.DEMO_CIAM_CLIENT_SECRET) {
		lines.push(`| \`DEMO_CIAM_CLIENT_SECRET\` | \`${derived.DEMO_CIAM_CLIENT_SECRET}\` |`);
	}
	if (derived.DEMO_IAM_CLIENT_SECRET) {
		lines.push(`| \`DEMO_IAM_CLIENT_SECRET\` | \`${derived.DEMO_IAM_CLIENT_SECRET}\` |`);
	}
	if (ctx.adminPassword) {
		lines.push(`| \`ADMIN_PASSWORD\` | \`${ctx.adminPassword}\` |`);
	}

	lines.push("");

	// ─── 4. GitHub Environment Variables ─────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 4. GitHub Environment Variables",
		"",
	);

	if (ghVarsUrl) {
		lines.push(`> ${ghVarsUrl}`);
	}

	lines.push(
		"",
		"Set each variable under **Settings → Environments → production → Environment variables**.",
		"",
		"| Variable | Value |",
		"|----------|-------|",
	);

	// Infrastructure
	lines.push(`| \`DEPLOY_PATH\` | \`${ctx.deployPath}\` |`);
	lines.push(`| \`DEPLOY_SSH_PORT\` | \`${ctx.sshPort}\` |`);
	if (ctx.ghcrUsername) {
		lines.push(`| \`GHCR_USERNAME\` | \`${ctx.ghcrUsername}\` |`);
	}

	// Domain URLs
	for (const [key, value] of Object.entries(domainUrls)) {
		lines.push(`| \`${key}\` | \`${value}\` |`);
	}

	// Email
	if (domain) {
		lines.push(`| \`SMTP_FROM_EMAIL\` | \`noreply@${domain}\` |`);
	}

	// OAuth2 client IDs
	lines.push(`| \`ATHENA_CIAM_OAUTH_CLIENT_ID\` | \`athena-ciam-client\` |`);
	lines.push(`| \`ATHENA_IAM_OAUTH_CLIENT_ID\` | \`athena-iam-client\` |`);
	if (ctx.includeDemo) {
		lines.push(`| \`DEMO_CIAM_CLIENT_ID\` | \`demo-ciam-client\` |`);
		lines.push(`| \`DEMO_IAM_CLIENT_ID\` | \`demo-iam-client\` |`);
	}

	// Admin & Image tags
	if (ctx.adminEmail) {
		lines.push(`| \`ADMIN_EMAIL\` | \`${ctx.adminEmail}\` |`);
	}
	lines.push(`| \`HERA_IMAGE_TAG\` | \`latest\` |`);
	lines.push(`| \`ATHENA_IMAGE_TAG\` | \`latest\` |`);
	lines.push(`| \`DEMO_IMAGE_TAG\` | \`latest\` |`);

	lines.push("");

	// ─── 5. GitHub Repository Secrets ────────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 5. GitHub Repository Secrets",
		"",
	);

	if (repo) {
		lines.push(`> https://github.com/${repo}/settings/secrets/actions`);
	}

	lines.push(
		"",
		"Set these under **Settings → Secrets and variables → Actions → Repository secrets** (not environment-scoped).",
		"",
		"| Secret | Value | Notes |",
		"|--------|-------|-------|",
		"| `NPM_TOKEN` | *(create at npmjs.com/settings/tokens)* | Type: Automation — needed only for CLI publishing |",
		"",
	);

	// ─── 6. DigitalOcean Droplet ─────────────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 6. DigitalOcean Droplet",
		"",
		"> https://cloud.digitalocean.com/droplets",
		"",
	);

	if (ctx.dropletIp) {
		lines.push(`Droplet IP: \`${ctx.dropletIp}\``);
	}
	if (ctx.sshPublicKeyPath) {
		lines.push("", `Add the deploy public key to the Droplet's \`~/.ssh/authorized_keys\`:`, "");
		lines.push("```");
		lines.push(`cat ${ctx.sshPublicKeyPath} | ssh ${ctx.sshUser || "root"}@${ctx.dropletIp || "DROPLET_IP"} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`);
		lines.push("```");
	}

	lines.push("");

	// ─── 7. Reference: Local Files ──────────────────────────────────────────

	lines.push(
		"---",
		"",
		"## 7. Reference",
		"",
		"These values are not inserted anywhere but are useful for reference.",
		"",
		"| Setting | Value |",
		"|---------|-------|",
		`| Domain | \`${domain}\` |`,
		`| Admin email | \`${ctx.adminEmail}\` |`,
		`| Include demo | ${ctx.includeDemo} |`,
	);

	if (ctx.passphrase) {
		lines.push(`| Passphrase | \`${ctx.passphrase}\` |`);
	}
	if (ctx.sshPrivateKeyPath) {
		lines.push(`| SSH private key | \`${ctx.sshPrivateKeyPath}\` |`);
	}
	if (ctx.sshPublicKeyPath) {
		lines.push(`| SSH public key | \`${ctx.sshPublicKeyPath}\` |`);
	}
	if (repo) {
		lines.push(`| Repository | \`${repo}\` |`);
	}
	if (ctx.hostingerToken) {
		lines.push(`| Hostinger token | \`${ctx.hostingerToken}\` |`);
	}
	if (ctx.doToken) {
		lines.push(`| DigitalOcean token | \`${ctx.doToken}\` |`);
	}

	lines.push("");

	writeFileSync(filePath, lines.join("\n"), "utf-8");
	ui.success(`Settings saved to ${ui.cmd(filePath)}`);
}

async function checkPrerequisites(): Promise<void> {
	const ghAvailable = await commandExists("gh");
	if (!ghAvailable) {
		ui.error(`GitHub CLI ${ui.cmd("gh")} is required. Install: ${ui.cmd(installHint("gh"))}`);
		process.exit(1);
	}
	ui.success(`GitHub CLI ${ui.cmd("gh")} found`);

	const sshKeygenAvailable = await commandExists("ssh-keygen");
	if (!sshKeygenAvailable) {
		ui.error(`${ui.cmd("ssh-keygen")} is required but not found on PATH`);
		process.exit(1);
	}
}

// Run
main().catch((err) => {
	if (err.name === "ExitPromptError") {
		// User pressed Ctrl+C
		console.log("\n");
		ui.info("Setup cancelled.");
		process.exit(0);
	}
	ui.error(err.message);
	process.exit(1);
});
