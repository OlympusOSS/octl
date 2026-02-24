import { execFile } from "node:child_process";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Execute a command and return stdout/stderr/exitCode.
 * Does NOT throw on non-zero exit — check exitCode yourself.
 */
export function exec(command: string, args: string[] = [], options?: { stdin?: string; timeout?: number }): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = execFile(command, args, { timeout: options?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({
				stdout: stdout.toString().trim(),
				stderr: stderr.toString().trim(),
				exitCode: error ? ((error as any).code ?? 1) : 0,
			});
		});

		if (options?.stdin && child.stdin) {
			child.stdin.write(options.stdin);
			child.stdin.end();
		}
	});
}

/**
 * Execute a command and throw if it fails.
 */
export async function execOrThrow(command: string, args: string[] = [], options?: { stdin?: string; timeout?: number }): Promise<string> {
	const result = await exec(command, args, options);
	if (result.exitCode !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

/**
 * Check if a CLI tool is available on PATH.
 * Uses `where` on Windows, `which` on Unix/macOS.
 */
export async function commandExists(command: string): Promise<boolean> {
	const check = process.platform === "win32" ? "where" : "which";
	const result = await exec(check, [command]);
	return result.exitCode === 0;
}

/**
 * Returns platform-aware install instructions for a CLI tool.
 */
export function installHint(tool: string): string {
	const hints: Record<string, Record<string, string>> = {
		gh: {
			darwin: "brew install gh",
			linux: "https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
			win32: "winget install GitHub.cli",
		},
		doctl: {
			darwin: "brew install doctl",
			linux: "snap install doctl",
			win32: "winget install DigitalOcean.Doctl",
		},
	};
	const platform = process.platform as string;
	return hints[tool]?.[platform] ?? hints[tool]?.linux ?? `Install ${tool} from its official website`;
}
