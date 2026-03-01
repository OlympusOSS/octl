# octl

Interactive CLI for deploying the [OlympusOSS Identity Platform](https://github.com/OlympusOSS/platform) to production.

---

## What It Does

Walks you through a 7-step setup wizard to provision infrastructure, configure secrets, set up DNS, and deploy — all from your terminal.

### Steps

1. **Resend** — Add your domain to [Resend](https://resend.com) and retrieve email DNS records
2. **Hostinger** — Sync A records and email DNS records to Hostinger (or display them for manual entry)
3. **DigitalOcean** — Create a new Droplet or connect to an existing one, generate SSH keys
4. **GitHub Environment** — Create a `production` environment in your GitHub repo
5. **GitHub Secrets** — Derive all secrets from a single passphrase (PBKDF2) and push to GitHub
6. **GitHub Variables** — Set all environment variables (domain URLs, client IDs, image tags)
7. **Deploy** — Trigger the GitHub Actions deploy workflow

Each step can be run independently. Select which steps to execute via an interactive menu.

---

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [GitHub CLI](https://cli.github.com/) — run `gh auth login` first

Optional (the CLI tells you if needed):
- [doctl](https://docs.digitalocean.com/reference/doctl/) — only if creating a new Droplet

---

## Workspace

octl is part of the [OlympusOSS Identity Platform](https://github.com/OlympusOSS/platform). All repos should be cloned as siblings under a shared workspace:

```
Olympus/
├── platform/    # Infrastructure & Docker Compose
├── athena/      # Admin dashboard
├── hera/        # Auth & consent UI
├── site/        # Brochure site & OAuth2 playground
├── canvas/      # Design system
└── octl/        # Deployment CLI (this repo)
```

octl is a **standalone deployment tool** — it is not part of the Docker Compose development environment. It's used to provision infrastructure and deploy the platform to production.

---

## Usage

```bash
cd octl
npm install
npm run octl
```

You'll be prompted for:

| Input | Description |
|-------|-------------|
| Domain name | e.g., `example.com` |
| Passphrase | Derives all secrets deterministically |
| Admin email + password | Initial admin identity |
| Resend API key | Transactional email |
| GitHub PAT | `read:packages` scope for pulling container images |
| Hostinger API token | Optional — can set DNS manually |
| DigitalOcean API token | Only if creating a new Droplet |

---

## Deterministic Secrets

All secrets are derived from a single passphrase using PBKDF2 (SHA-256, 600k iterations). Same passphrase always produces the same secrets — useful for reproducibility and disaster recovery.

Derived secrets include: PostgreSQL password, Kratos cookie/cipher secrets, Hydra system secrets, Hydra pairwise salts, OAuth2 client secrets.

---

## Output

After running, octl saves a reference file to `~/Documents/octl/octl.md` containing all configured values, DNS records, and SSH key paths.

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js (ESM) |
| Language | TypeScript |
| Prompts | @inquirer/prompts |
| Linting | Biome |
| Infrastructure | GitHub CLI, doctl, ssh-keygen |

---

## Project Structure

```
src/
├── index.ts            # Main CLI entry — step orchestration
├── types.ts            # SetupContext, StepId types
├── lib/
│   ├── crypto.ts       # PBKDF2 secret derivation
│   ├── github.ts       # GitHub CLI wrapper (environments, secrets, variables)
│   ├── shell.ts        # Cross-platform command execution
│   └── ui.ts           # Terminal formatting + colors
└── steps/
    ├── resend.ts       # Step 1: Email provider
    ├── hostinger.ts    # Step 2: DNS management
    ├── droplet.ts      # Step 3: DigitalOcean setup
    ├── github-env.ts   # Step 4: GitHub environment
    ├── github-secrets.ts # Step 5: Derived secrets
    ├── github-vars.ts  # Step 6: Environment variables
    └── deploy.ts       # Step 7: Trigger deployment
```

---

## License

MIT
