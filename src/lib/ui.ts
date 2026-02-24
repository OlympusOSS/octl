// Detect color support: Windows cmd.exe without virtual terminal support gets no colors.
// Windows Terminal, PowerShell 7+, and all Unix terminals support ANSI.
const supportsColor =
	process.env.NO_COLOR == null &&
	(process.platform !== "win32" ||
		!!process.env.WT_SESSION || // Windows Terminal
		!!process.env.TERM_PROGRAM || // VS Code, etc.
		process.env.TERM === "xterm" ||
		process.env.TERM === "xterm-256color");

const c = (code: string) => (supportsColor ? code : "");

const RESET = c("\x1b[0m");
const BOLD = c("\x1b[1m");
const DIM = c("\x1b[2m");
const ITALIC = c("\x1b[3m");
const UNDERLINE = c("\x1b[4m");
const GREEN = c("\x1b[32m");
const YELLOW = c("\x1b[33m");
const CYAN = c("\x1b[36m");
const RED = c("\x1b[31m");
const MAGENTA = c("\x1b[35m");
const _BLUE = c("\x1b[34m");
const WHITE = c("\x1b[37m");
const _BG_CYAN = c("\x1b[46m");
const _BG_BLUE = c("\x1b[44m");

// ─── Inline colour helpers (exported for use in prompts & messages) ────────

/** Bold text. */
export function bold(text: string): string {
	return `${BOLD}${text}${RESET}`;
}

/** Dim/muted text. */
export function dim(text: string): string {
	return `${DIM}${text}${RESET}`;
}

/** Cyan text (info, highlights). */
export function cyan(text: string): string {
	return `${CYAN}${text}${RESET}`;
}

/** Green text (success, domains). */
export function green(text: string): string {
	return `${GREEN}${text}${RESET}`;
}

/** Yellow text (warnings, commands). */
export function yellow(text: string): string {
	return `${YELLOW}${text}${RESET}`;
}

/** Red text (errors). */
export function red(text: string): string {
	return `${RED}${text}${RESET}`;
}

/** Magenta text (secrets, keys). */
export function magenta(text: string): string {
	return `${MAGENTA}${text}${RESET}`;
}

/** Underlined cyan — for URLs. */
export function url(text: string): string {
	return `${UNDERLINE}${CYAN}${text}${RESET}`;
}

/** Yellow bold — for CLI commands. */
export function cmd(text: string): string {
	return `${YELLOW}${text}${RESET}`;
}

/** Cyan bold — for variable/secret names. */
export function label(text: string): string {
	return `${CYAN}${BOLD}${text}${RESET}`;
}

/** Green bold — for domain names and IPs. */
export function host(text: string): string {
	return `${GREEN}${BOLD}${text}${RESET}`;
}

/** Dim italic — for hints/descriptions. */
export function hint(text: string): string {
	return `${DIM}${ITALIC}${text}${RESET}`;
}

// ─── Output functions ──────────────────────────────────────────────────────

/** Print the welcome banner. */
export function banner(): void {
	console.log("");
	console.log(`${BOLD}${CYAN}  ╔═══════════════════════════════════════╗${RESET}`);
	console.log(`${BOLD}${CYAN}  ║${RESET}${BOLD}${WHITE}     ⚡  Olympus CLI ${DIM}(octl)${RESET}${BOLD}${WHITE}    ${BOLD}${CYAN}       ║${RESET}`);
	console.log(`${BOLD}${CYAN}  ╚═══════════════════════════════════════╝${RESET}`);
	console.log(`${DIM}  Automated setup for the OlympusOSS Identity Platform${RESET}`);
	console.log("");
}

/** Print a numbered step header. */
export function stepHeader(step: number, total: number, title: string): void {
	console.log("");
	console.log(`${BOLD}${CYAN}  ━━━ ${WHITE}Step ${YELLOW}${step}${WHITE}/${DIM}${total}${RESET}${BOLD}${WHITE} — ${CYAN}${title} ${CYAN}━━━${RESET}`);
	console.log("");
}

/** Print a success message with a checkmark. */
export function success(msg: string): void {
	console.log(`  ${GREEN}✔${RESET} ${msg}`);
}

/** Print a skip message. */
export function skip(msg: string): void {
	console.log(`  ${DIM}⊘ ${msg}${RESET}`);
}

/** Print an info message. */
export function info(msg: string): void {
	console.log(`  ${CYAN}ℹ${RESET} ${msg}`);
}

/** Print a warning message. */
export function warn(msg: string): void {
	console.log(`  ${YELLOW}⚠${RESET} ${YELLOW}${msg}${RESET}`);
}

/** Print an error message. */
export function error(msg: string): void {
	console.log(`  ${RED}✖${RESET} ${RED}${msg}${RESET}`);
}

/** Print a key=value pair for summaries. */
export function keyValue(key: string, value: string): void {
	console.log(`  ${DIM}${key}:${RESET} ${BOLD}${WHITE}${value}${RESET}`);
}

/** Print a table of records (for DNS summaries). */
export function table(headers: string[], rows: string[][]): void {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));

	const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
	const formatHeader = (row: string[]) => row.map((cell, i) => ` ${BOLD}${CYAN}${(cell ?? "").padEnd(widths[i])}${RESET} `).join(`${DIM}│${RESET}`);
	const formatRow = (row: string[]) => row.map((cell, i) => ` ${(cell ?? "").padEnd(widths[i])} `).join(`${DIM}│${RESET}`);

	console.log(`  ${DIM}${sep}${RESET}`);
	console.log(`  ${formatHeader(headers)}`);
	console.log(`  ${DIM}${sep}${RESET}`);
	for (const row of rows) {
		console.log(`  ${formatRow(row)}`);
	}
	console.log(`  ${DIM}${sep}${RESET}`);
}

/** Pause with a message — user presses Enter to continue. */
export async function pause(msg: string): Promise<void> {
	const { input } = await import("@inquirer/prompts");
	await input({ message: `${msg} — press ${bold("Enter")} to continue` });
}

/** Print a completion summary box. */
export function summaryBox(title: string): void {
	console.log("");
	console.log(`${BOLD}${GREEN}  ╔═══════════════════════════════════════╗${RESET}`);
	console.log(`${BOLD}${GREEN}  ║${RESET}${BOLD}${WHITE}  ✔ ${title.padEnd(35)}${BOLD}${GREEN}║${RESET}`);
	console.log(`${BOLD}${GREEN}  ╚═══════════════════════════════════════╝${RESET}`);
	console.log("");
}
