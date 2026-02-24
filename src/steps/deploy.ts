import { confirm } from "@inquirer/prompts";
import * as github from "../lib/github.js";
import * as ui from "../lib/ui.js";
import type { SetupContext } from "../types.js";

/**
 * Step 7 — Deploy: trigger the GitHub Actions deploy workflow.
 */
export async function run(_ctx: SetupContext): Promise<void> {
	const proceed = await confirm({
		message: `Trigger the ${ui.bold("deploy workflow")} now?`,
		default: true,
	});

	if (!proceed) {
		ui.info(`Skipped. You can deploy manually: ${ui.bold("Actions")} → ${ui.bold("Deploy")} → ${ui.bold("Run workflow")}`);
		return;
	}

	ui.info("Triggering deploy workflow...");

	try {
		await github.triggerWorkflow("deploy.yml", { environment: "production" });
		ui.success("Deploy workflow triggered");
		ui.info(`Monitor progress: ${ui.bold("Actions")} → ${ui.bold("Deploy")} in your GitHub repo`);
	} catch (err: any) {
		ui.error(`Failed to trigger workflow: ${err.message}`);
		ui.info(`You can trigger it manually: ${ui.bold("Actions")} → ${ui.bold("Deploy")} → ${ui.bold("Run workflow")} → ${ui.green("production")}`);
	}
}
