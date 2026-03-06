import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupContext } from "../types.js";
import * as ui from "./ui.js";

function getSettingsDir(): string {
	// macOS/Windows have Documents; Linux uses a hidden dotfolder in home
	if (process.platform === "linux") {
		return join(homedir(), ".octl");
	}
	return join(homedir(), "Documents", "octl");
}

/** Load previously saved context, merging into the given ctx. */
export function loadPreviousContext(ctx: SetupContext): void {
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

export function saveSettings(ctx: SetupContext, quiet = false): void {
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
