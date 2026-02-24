import { input } from "@inquirer/prompts";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

/**
 * Step 4 — GitHub Environment: create the production environment.
 *
 * - Ensures gh CLI is authenticated
 * - Detects repo from git remote
 * - Creates the "production" environment (idempotent via PUT)
 */
export async function run(ctx: SetupContext): Promise<void> {
	// Ensure gh is authenticated and get username
	const username = await github.ensureGhAuth();
	ctx.ghcrUsername = ctx.ghcrUsername || username;
	ui.success(`Authenticated as ${ui.bold(username)}`);

	// Detect repo
	const detected = await github.detectRepo();
	if (detected) {
		ctx.repoOwner = detected.owner;
		ctx.repoName = detected.name;
		ui.success(`Detected repo: ${ui.bold(`${detected.owner}/${detected.name}`)}`);
	} else {
		ui.warn("Could not detect repo from git remote");
		const slug = await input({
			message: `${ui.cyan("GitHub repo")} ${ui.dim("(owner/name)")}:`,
			validate: (v) => (v.includes("/") ? true : "Format: owner/name"),
		});
		const [owner, name] = slug.split("/");
		ctx.repoOwner = owner;
		ctx.repoName = name;
	}

	// Create environment
	const ok = await github.createEnvironment(ctx.repoOwner, ctx.repoName, "production");
	if (ok) {
		ui.success(`Environment ${ui.label("production")} is ready`);
	} else {
		ui.warn(`Could not create environment — it may require admin access. Create it manually in repo ${ui.bold("Settings")}.`);
	}
}
