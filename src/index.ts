#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { checkbox, confirm, input, password } from "@inquirer/prompts";
import { deriveAllSecrets } from "./lib/crypto.js";
import { commandExists, installHint } from "./lib/shell.js";
import * as ui from "./lib/ui.js";
import * as appDeploySecretsStep from "./steps/app-deploy-secrets.js";
import * as dropletStep from "./steps/droplet.js";
import * as githubEnvStep from "./steps/github-env.js";
import * as githubSecretsStep from "./steps/github-secrets.js";
import * as githubVarsStep from "./steps/github-vars.js";
import * as neonStep from "./steps/neon.js";
// Step modules
import * as resendStep from "./steps/resend.js";
import { createEmptyContext, type SetupContext, type StepId } from "./types.js";

interface Step {
	id: StepId;
	label: string;
	description: string;
	run: (ctx: SetupContext) => Promise<void>;
	/** Which common inputs this step requires. */
	needs: ("domain" | "passphrase" | "adminPassword" | "includeSite")[];
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
		id: "neon",
		label: "Neon",
		description: "Managed PostgreSQL — create project + databases",
		run: neonStep.run,
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
		needs: ["domain", "adminPassword"],
	},
	{
		id: "github-vars",
		label: "GitHub Variables",
		description: "Compute + set all variables",
		run: githubVarsStep.run,
		needs: ["domain"],
	},
	{
		id: "app-deploy-secrets",
		label: "App Deploy Secrets",
		description: "Set SSH + GHCR credentials on app repos (athena, hera, site)",
		run: appDeploySecretsStep.run,
		needs: [],
	},
];

// Module-level ref so exit handlers can save progress
let activeCtx: SetupContext | null = null;

function saveOnExit(): void {
	if (activeCtx && (activeCtx.domain || activeCtx.passphrase || activeCtx.doToken)) {
		saveSettings(activeCtx, true);
	}
}

function setupEscapeHandler(): void {
	// Enable keypress events on stdin so we can detect Escape
	emitKeypressEvents(process.stdin);

	process.stdin.on("keypress", (_ch: string, key: { name: string }) => {
		if (key?.name === "escape") {
			console.log("\n");
			saveOnExit();
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
	loadPreviousContext(ctx);
	ctx.selectedSteps = selectedIds;
	activeCtx = ctx;

	const selectedSteps = STEPS.filter((s) => selectedIds.includes(s.id));

	// Collect common inputs upfront (only what selected steps need)
	const allNeeds = new Set(selectedSteps.flatMap((s) => s.needs));

	if (allNeeds.has("domain")) {
		ctx.domain = await input({
			message: `${ui.cyan("Domain name")} ${ui.dim("(e.g. example.com)")}:`,
			default: ctx.domain || undefined,
			validate: (v) => (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? true : "Enter a valid domain name"),
		});
		saveSettings(ctx, true);
	}

	// Always collect passphrase — it's the master key for the whole platform
	if (ctx.passphrase) {
		// Prefilled from previous run — let user confirm or change
		ctx.passphrase = await input({
			message: `${ui.cyan("Passphrase")} ${ui.dim("(used to derive all secrets)")}:`,
			default: ctx.passphrase,
			validate: (v) => (v.length >= 8 ? true : "Passphrase must be at least 8 characters"),
		});
	} else {
		while (true) {
			ctx.passphrase = await password({
				message: `${ui.cyan("Passphrase")} ${ui.dim("(used to derive all secrets — remember this!)")}:`,
				validate: (v) => (v.length >= 8 ? true : "Passphrase must be at least 8 characters"),
			});

			const confirmPass = await password({ message: `${ui.cyan("Confirm passphrase")}:` });
			if (confirmPass === ctx.passphrase) break;

			ui.error("Passphrases do not match.");
			const retry = await confirm({
				message: "Would you like to try again?",
				default: true,
			});
			if (!retry) {
				ui.info("Exiting.");
				process.exit(0);
			}
		}
	}

	saveSettings(ctx, true);

	if (allNeeds.has("adminPassword")) {
		ctx.adminEmail = await input({
			message: `${ui.cyan("Admin email")} ${ui.dim("(for initial IAM admin identity)")}:`,
			default: ctx.adminEmail || (ctx.domain ? `admin@${ctx.domain}` : undefined),
			validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? true : "Enter a valid email address"),
		});
		saveSettings(ctx, true);

		ctx.adminPassword = await input({
			message: `${ui.cyan("Admin password")} ${ui.dim("(for initial IAM admin identity)")}:`,
			default: ctx.adminPassword || undefined,
			validate: (v) => (v.length >= 8 ? true : "Password must be at least 8 characters"),
		});
		saveSettings(ctx, true);
	}

	// Site OAuth2 clients are always included
	ctx.includeSite = true;

	// ── Collect GitHub repo if any GitHub steps are selected ─────────────

	const needsRepo = selectedIds.some((id) => id.startsWith("github-") || id === "app-deploy-secrets");
	if (needsRepo) {
		const defaultRepo = ctx.repoOwner && ctx.repoName ? `${ctx.repoOwner}/${ctx.repoName}` : undefined;
		const slug = await input({
			message: `${ui.cyan("GitHub repo")} ${ui.dim("(owner/name)")}:`,
			default: defaultRepo,
			validate: (v) => (v.includes("/") ? true : "Format: owner/name"),
		});
		const [owner, name] = slug.split("/");
		ctx.repoOwner = owner;
		ctx.repoName = name;
		saveSettings(ctx, true);
	}

	// ── Collect tokens & API keys upfront based on selected steps ────────

	const needsResendKey = selectedIds.includes("resend") || selectedIds.includes("github-secrets");
	const needsNeonToken = selectedIds.includes("neon") || selectedIds.includes("github-secrets");
	const needsDoToken = selectedIds.includes("droplet");
	const needsGhcrPat = selectedIds.includes("github-secrets") || selectedIds.includes("app-deploy-secrets");

	if (needsResendKey) {
		ui.info(`Create an API key at: ${ui.url("https://resend.com/api-keys")}`);
		ctx.resendApiKey = await input({
			message: `${ui.cyan("Resend API key")} ${ui.dim("(starts with re_)")}:`,
			default: ctx.resendApiKey || undefined,
			validate: (v) => (v.startsWith("re_") ? true : "API key must start with re_"),
		});
		saveSettings(ctx, true);
	}

	if (needsNeonToken) {
		ui.info(`Create an API key at: ${ui.url("https://console.neon.tech/app/settings/api-keys")}`);
		ctx.neonApiToken = await input({
			message: `${ui.cyan("Neon API token")}:`,
			default: ctx.neonApiToken || undefined,
			validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
		});
		saveSettings(ctx, true);
	}

	if (needsDoToken) {
		ui.info(`Create an API token at: ${ui.url("https://cloud.digitalocean.com/account/api/tokens")}`);
		ctx.doToken = await input({
			message: `${ui.cyan("DigitalOcean API token")}:`,
			default: ctx.doToken || undefined,
			validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
		});
		saveSettings(ctx, true);
	}

	if (needsGhcrPat) {
		ui.info(`Create a PAT at: ${ui.url("https://github.com/settings/tokens")} — scope: ${ui.bold("read:packages")}`);
		ctx.ghcrPat = await input({
			message: `${ui.cyan("GitHub PAT")} ${ui.dim("(read:packages)")}:`,
			default: ctx.ghcrPat || undefined,
			validate: (v) => (v.length > 0 ? true : "Token cannot be empty"),
		});
		saveSettings(ctx, true);
	}

	// Derive all secrets from passphrase and save to octl.json
	if (ctx.passphrase) {
		ctx.derivedSecrets = deriveAllSecrets(ctx.passphrase, ctx.includeSite);
		saveSettings(ctx, true);
	}

	// Run selected steps
	const failedStepIds = new Set<StepId>();
	const total = selectedSteps.length;
	for (let i = 0; i < selectedSteps.length; i++) {
		const step = selectedSteps[i];
		ui.stepHeader(i + 1, total, step.label);

		let succeeded = false;
		while (!succeeded) {
			try {
				await step.run(ctx);
				succeeded = true;
				saveSettings(ctx, true);
			} catch (err: any) {
				// Save whatever the step collected before it failed
				saveSettings(ctx, true);
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
					ui.info(`Exiting. You can re-run ${ui.cmd("octl")} and select only the remaining steps.`);
					process.exit(1);
				}

				failedStepIds.add(step.id);
				break;
			}
		}
	}

	// Final save (loud — shows path to the user)
	saveSettings(ctx);

	// Summary
	ui.summaryBox("Setup Complete");
	if (ctx.domain) ui.keyValue("Domain", ctx.domain);
	if (ctx.dropletIp) ui.keyValue("Droplet IP", ctx.dropletIp);
	if (ctx.neonProjectId) ui.keyValue("Neon Project", ctx.neonProjectId);
	if (ctx.repoOwner) ui.keyValue("Repo", `${ctx.repoOwner}/${ctx.repoName}`);
	if (ctx.adminEmail) ui.keyValue("Admin email", ctx.adminEmail);
	console.log("");

	// Always print DNS setup instructions if we have domain + IP
	if (ctx.domain && ctx.dropletIp) {
		ui.info(ui.bold("DNS Records") + ui.dim(" — add these at your DNS provider:"));
		console.log("");

		ui.info(ui.bold("A Records") + ui.dim(` → all point to ${ctx.dropletIp}`));
		ui.table(
			["Type", "Name", "Value", "TTL"],
			["login.ciam", "login.iam", "oauth.ciam", "oauth.iam", "admin.ciam", "admin.iam", "olympus"].map((sub) => ["A", sub, ctx.dropletIp, "3600"]),
		);
		console.log("");
	}

	if (ctx.resendDnsRecords.length > 0) {
		ui.info(ui.bold("Resend Email DNS Records"));
		ui.table(
			["Type", "Name", "Value", "Priority"],
			ctx.resendDnsRecords.map((r) => [
				r.type,
				r.name || "(root)",
				r.value.length > 60 ? `${r.value.substring(0, 57)}...` : r.value,
				r.priority !== undefined ? String(r.priority) : "",
			]),
		);
		console.log("");
	}
}

function getSettingsDir(): string {
	// macOS/Windows have Documents; Linux uses a hidden dotfolder in home
	if (process.platform === "linux") {
		return join(homedir(), ".octl");
	}
	return join(homedir(), "Documents", "octl");
}

/** Load previously saved context, merging into the given ctx. */
function loadPreviousContext(ctx: SetupContext): void {
	const jsonPath = join(getSettingsDir(), "octl.json");
	if (!existsSync(jsonPath)) return;

	try {
		const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));

		for (const key of Object.keys(ctx) as (keyof SetupContext)[]) {
			const current = ctx[key];
			const saved = raw[key];
			if (saved === undefined || saved === null) continue;

			// Skip if the current value is already set (non-empty string, non-default)
			if (typeof current === "string" && current !== "") continue;
			if (key === "resendDnsRecords" && Array.isArray(current) && current.length > 0) continue;
			if (key === "selectedSteps") continue; // always use the current selection

			// @ts-expect-error — dynamic assignment
			ctx[key] = saved;
		}
	} catch {
		// Corrupt or missing — ignore
	}
}

function saveSettings(ctx: SetupContext, quiet = false): void {
	const octlDir = getSettingsDir();
	const filePath = join(octlDir, "octl.json");

	if (!existsSync(octlDir)) {
		mkdirSync(octlDir, { recursive: true });
	}

	writeFileSync(filePath, JSON.stringify(ctx, null, 2), "utf-8");
	if (!quiet) {
		ui.success(`Settings saved to ${ui.cmd(filePath)}`);
	}
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
	saveOnExit();
	if (err.name === "ExitPromptError") {
		// User pressed Ctrl+C
		console.log("\n");
		ui.info("Setup cancelled.");
		process.exit(0);
	}
	ui.error(err.message);
	process.exit(1);
});
