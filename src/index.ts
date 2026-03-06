#!/usr/bin/env node

import { emitKeypressEvents } from "node:readline";
import { select } from "@inquirer/prompts";
import * as deployCommand from "./commands/deploy.js";
import * as destroyCommand from "./commands/destroy.js";
import * as devCommand from "./commands/dev.js";
import * as modifyCommand from "./commands/modify.js";
import { loadPreviousContext, saveSettings } from "./lib/settings.js";
import * as ui from "./lib/ui.js";
import { createEmptyContext, type MenuAction, type Mode, type SetupContext } from "./types.js";

// Module-level ref so exit handlers can save progress
let activeCtx: SetupContext | null = null;

function saveOnExit(): void {
	if (activeCtx && (activeCtx.domain || activeCtx.passphrase || activeCtx.doToken)) {
		saveSettings(activeCtx, true);
	}
}

function setupEscapeHandler(): void {
	emitKeypressEvents(process.stdin);

	process.stdin.on("keypress", (_ch: string, key: { name: string }) => {
		if (key?.name === "escape") {
			console.log("\n");
			saveOnExit();
			ui.info("Cancelled.");
			process.exit(0);
		}
	});
}

/**
 * Resolve the CLI mode from argv or interactive prompt.
 */
async function resolveMode(): Promise<Mode> {
	const arg = process.argv[2];

	if (arg === "dev") return "dev";
	if (arg === "prod") return "prod";

	if (arg && arg !== "dev" && arg !== "prod") {
		ui.error(`Unknown mode: ${ui.bold(arg)}`);
		ui.info(`Usage: ${ui.cmd("octl")} ${ui.dim("[dev|prod]")}`);
		process.exit(1);
	}

	// No argument — prompt for mode
	return select<Mode>({
		message: "Select environment:",
		choices: [
			{
				name: `${ui.cyan("1.")} ${ui.bold("Development")} ${ui.dim("— Install prerequisites & bootstrap local stack")}`,
				value: "dev",
			},
			{
				name: `${ui.cyan("2.")} ${ui.bold("Production")} ${ui.dim("— Deploy, modify, or destroy production resources")}`,
				value: "prod",
			},
		],
	});
}

/**
 * Show the production master menu and dispatch to the selected command.
 */
async function prodMenu(ctx: SetupContext): Promise<void> {
	const action = await select<MenuAction>({
		message: "What would you like to do?",
		choices: [
			{
				name: `${ui.cyan("1.")} ${ui.bold("Deploy")} ${ui.dim("— Provision infrastructure & configure secrets")}`,
				value: "deploy",
			},
			{
				name: `${ui.cyan("2.")} ${ui.bold("Modify")} ${ui.dim("— Modify an existing deployment")}`,
				value: "modify",
			},
			{
				name: `${ui.cyan("3.")} ${ui.bold("Destroy")} ${ui.dim("— Tear down resources")}`,
				value: "destroy",
			},
		],
	});

	switch (action) {
		case "deploy":
			await deployCommand.run(ctx);
			break;
		case "modify":
			await modifyCommand.run(ctx);
			break;
		case "destroy":
			await destroyCommand.run(ctx);
			break;
	}
}

async function main(): Promise<void> {
	ui.banner();
	setupEscapeHandler();

	const mode = await resolveMode();

	if (mode === "dev") {
		await devCommand.run();
		return;
	}

	// Production mode — load context and show master menu
	const ctx = createEmptyContext();
	ctx.mode = "prod";
	loadPreviousContext(ctx);
	activeCtx = ctx;

	await prodMenu(ctx);
}

main().catch((err) => {
	saveOnExit();
	if (err.name === "ExitPromptError") {
		console.log("\n");
		ui.info("Cancelled.");
		process.exit(0);
	}
	ui.error(err.message);
	process.exit(1);
});
