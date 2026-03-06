/**
 * SSH transport layer for octl.
 *
 * Routes HTTP requests through an SSH tunnel using ControlMaster
 * for connection reuse. This lets the CLI call Kratos admin APIs
 * on a remote Droplet where the ports are not publicly exposed.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupContext } from "../types.js";
import { exec } from "./shell.js";
import * as ui from "./ui.js";

/** A fetch-compatible function signature for Kratos API calls. */
export type KratosFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Default fetcher — delegates to the global fetch(). */
export const defaultFetcher: KratosFetcher = (url, init) => fetch(url, init);

/** Derive the ControlMaster socket path for a given Droplet IP. */
function socketPath(dropletIp: string): string {
	return join(tmpdir(), `octl-ssh-${dropletIp}`);
}

/** Escape a string for safe use inside single-quoted shell arguments. */
function shellEscape(str: string): string {
	// Replace every ' with '\'' (end quote, escaped quote, start quote)
	return str.replace(/'/g, "'\\''");
}

/** Common SSH args for ControlMaster operations. */
function sshBaseArgs(ctx: SetupContext): string[] {
	const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", `ControlPath=${socketPath(ctx.dropletIp)}`, "-p", String(ctx.sshPort || 22)];
	if (ctx.sshPrivateKeyPath) {
		args.push("-i", ctx.sshPrivateKeyPath);
	}
	return args;
}

/**
 * Open an SSH ControlMaster connection to the Droplet.
 * Subsequent SSH commands reuse this connection via the socket.
 */
export async function openSshConnection(ctx: SetupContext): Promise<void> {
	const user = ctx.sshUser || "root";
	const target = `${user}@${ctx.dropletIp}`;
	const socket = socketPath(ctx.dropletIp);

	ui.info(`Opening SSH tunnel to ${ui.host(ctx.dropletIp)}...`);

	// Open ControlMaster in background (-fN = no command, fork to background)
	const result = await exec(
		"ssh",
		[
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPath=${socket}`,
			"-o",
			"ControlPersist=120",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ConnectTimeout=10",
			"-p",
			String(ctx.sshPort || 22),
			...(ctx.sshPrivateKeyPath ? ["-i", ctx.sshPrivateKeyPath] : []),
			"-fN",
			target,
		],
		{ timeout: 15_000 },
	);

	if (result.exitCode !== 0) {
		throw new Error(`Failed to open SSH connection to ${target}: ${result.stderr || result.stdout}`);
	}

	// Verify the connection is alive
	const check = await exec("ssh", ["-O", "check", ...sshBaseArgs(ctx), target], { timeout: 5_000 });

	if (check.exitCode !== 0) {
		throw new Error(`SSH ControlMaster check failed: ${check.stderr}`);
	}

	ui.success(`SSH tunnel established to ${ui.host(ctx.dropletIp)}`);
}

/**
 * Close the SSH ControlMaster connection.
 * Safe to call even if the connection is already closed.
 */
export async function closeSshConnection(ctx: SetupContext): Promise<void> {
	const user = ctx.sshUser || "root";
	const target = `${user}@${ctx.dropletIp}`;

	await exec("ssh", ["-O", "exit", ...sshBaseArgs(ctx), target], { timeout: 5_000 });
}

/**
 * Create a KratosFetcher that routes requests through SSH+curl.
 *
 * The fetcher executes `curl` on the remote Droplet via the
 * ControlMaster connection. It mimics the fetch() Response
 * interface enough for the Kratos API functions to work.
 */
export function createSshFetcher(ctx: SetupContext): KratosFetcher {
	const user = ctx.sshUser || "root";
	const target = `${user}@${ctx.dropletIp}`;

	return async (url: string, init?: RequestInit): Promise<Response> => {
		const method = (init?.method || "GET").toUpperCase();

		// Build the curl command
		const curlArgs: string[] = ["curl", "-sS", "-L"];

		// -w appends the HTTP status code on a new line after the body
		curlArgs.push("-w", "$'\\n%{http_code}'");

		// Method
		curlArgs.push("-X", method);

		// Headers
		const headers = init?.headers;
		if (headers) {
			if (headers instanceof Headers) {
				headers.forEach((value, key) => {
					curlArgs.push("-H", `'${shellEscape(`${key}: ${value}`)}'`);
				});
			} else if (Array.isArray(headers)) {
				for (const [key, value] of headers) {
					curlArgs.push("-H", `'${shellEscape(`${key}: ${value}`)}'`);
				}
			} else {
				for (const [key, value] of Object.entries(headers)) {
					curlArgs.push("-H", `'${shellEscape(`${key}: ${value}`)}'`);
				}
			}
		}

		// Body
		if (init?.body) {
			const bodyStr = typeof init.body === "string" ? init.body : String(init.body);
			curlArgs.push("-d", `'${shellEscape(bodyStr)}'`);
		}

		// URL (must be last)
		curlArgs.push(`'${shellEscape(url)}'`);

		// Execute via SSH
		const remoteCmd = curlArgs.join(" ");
		const result = await exec("ssh", [...sshBaseArgs(ctx), target, remoteCmd], { timeout: 30_000 });

		if (result.exitCode !== 0) {
			throw new Error(`SSH curl failed: ${result.stderr || result.stdout}`);
		}

		// Parse response: body is everything except the last line, which is the HTTP status code
		const output = result.stdout;
		const lastNewline = output.lastIndexOf("\n");
		const body = lastNewline >= 0 ? output.substring(0, lastNewline) : "";
		const statusStr = lastNewline >= 0 ? output.substring(lastNewline + 1).trim() : output.trim();
		const status = Number.parseInt(statusStr, 10) || 0;
		const ok = status >= 200 && status < 300;

		// Return a minimal Response-compatible object
		return {
			ok,
			status,
			statusText: ok ? "OK" : "Error",
			headers: new Headers(),
			redirected: false,
			type: "basic" as ResponseType,
			url,
			body: null,
			bodyUsed: false,
			clone: () => {
				throw new Error("clone() not implemented");
			},
			arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
			blob: () => Promise.resolve(new Blob()),
			bytes: () => Promise.resolve(new Uint8Array()),
			formData: () => Promise.resolve(new FormData()),
			text: () => Promise.resolve(body),
			json: () => Promise.resolve(JSON.parse(body)),
		} as Response;
	};
}
