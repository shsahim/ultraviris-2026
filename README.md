# ultraviris-2026

Next.js site for [nataliernathan.com](https://nataliernathan.com) — gallery,
contact form, and a password-protected admin area for database editing.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in DB, SSH, and admin credentials
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Admin UI is at `/admin`.

Moving to a new machine? See [docs/dev-environment-sync.md](docs/dev-environment-sync.md).

## Common commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Development server |
| `npm run build` / `npm run start` | Production build |
| `npm test` | Unit tests |
| `npm run env:push-gh` | Upload dev secrets to GitHub |
| `npm run env:pull-gh` | Restore dev secrets from GitHub |
| `make build` / `make run` | Local Docker image |
| `make ship` | Build, push to ECR, deploy |
| `make help` | All Make targets |

## Documentation

| Guide | Topics |
|-------|--------|
| [Configuration](docs/configuration.md) | `.env.local`, MySQL over SSH, admin, SES, health checks |
| [Dev environment sync](docs/dev-environment-sync.md) | Secrets between machines |
| [Deployment](docs/deployment.md) | Docker, CI/CD, ALB + ASG, manual deploy |
| [AWS setup](docs/aws-setup.md) | `setup-aws.sh`, provisioning scripts |
| [Production checklist](docs/production-checklist.md) | Pre-launch TODOs |

Full index: [docs/README.md](docs/README.md)
