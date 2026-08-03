# Documentation index

This index is the entry point for product reviewers, contest judges,
contributors, security reviewers, and operators. Every page describes the
current implementation unless it is explicitly labelled as roadmap work.

## Recommended reading paths

### Five-minute product review

1. [README](../README.md) — the problem, the solution rationale, how Zoo APIs are
   used, setup, and limitations.
2. [Product](PRODUCT.md) — users, workflows, evidence model, and acceptance criteria.
3. [Contest demo](DEMO.md) — repeatable judge-facing walkthrough.
4. [Judging map](JUDGING.md) — where each contest criterion is demonstrated.

### Zoo integration review

1. [README — How QuoteReady Studio uses Zoo APIs](../README.md#how-quoteready-studio-uses-zoo-apis)
   — the endpoint map, with the code that calls each one.
2. [Zoo API notes](ZOO_API_NOTES.md) — the endpoint reference as exercised, every
   bug and limitation found, documentation feedback, and reproductions.
3. [Zoo Agent](ZOO_AGENT.md) — the three copilot prompts, the pricing validation
   contract, and the deterministic fallback.

### Engineering review

1. [Architecture](ARCHITECTURE.md) — components, trust boundaries, and sequences.
2. [Internal HTTP API](API.md) — endpoint contracts, limits, and errors.
3. [Data model](DATA_MODEL.md) — workspace objects, lifecycle, and persistence.
4. [Zoo Agent](ZOO_AGENT.md) — agent request, validation, and fallback.
5. [Code quality](CODE_QUALITY.md) — module boundaries and maintainability controls.
6. [Testing](TESTING.md) — automated and manual verification strategy.

### Deployment and operations

1. [Deployment](DEPLOYMENT.md) — prerequisites and first deployment.
2. [Operations](OPERATIONS.md) — health, logs, backup, restore, capacity, incidents.
3. [OAuth setup](OAUTH_SETUP.md) — Zoo application registration and diagnostics.
4. [Security](SECURITY.md) — assets, controls, data handling, and reporting.
5. [Limitations](LIMITATIONS.md) — scaling and product boundaries.

### Design review

1. [Design system](DESIGN_SYSTEM.md) — visual language, tokens, components, and accessibility.
2. [Product](PRODUCT.md) — interaction goals and evidence hierarchy.
3. [Testing](TESTING.md#manual-interface-matrix) — responsive and accessibility checks.

## Document catalogue

| Document | Audience | Purpose |
|---|---|---|
| [README](../README.md) | Everyone | Product overview, setup, and main links |
| [Product](PRODUCT.md) | Judges, product, engineering | Product contract and workflows |
| [Architecture](ARCHITECTURE.md) | Engineering, security | Runtime design and data flow |
| [Internal HTTP API](API.md) | Frontend and backend contributors | Endpoint and validation contract |
| [Data model](DATA_MODEL.md) | Engineering, operations | Types, invariants, lifecycle, retention |
| [Zoo Agent](ZOO_AGENT.md) | Engineering, judges | Agent request, validation, and fallback |
| [Zoo API notes](ZOO_API_NOTES.md) | Integrators | Observed Zoo contracts and reproducible issue notes |
| [OAuth setup](OAUTH_SETUP.md) | Developers, operators | Zoo application registration and diagnostics |
| [Design system](DESIGN_SYSTEM.md) | Design, frontend | Visual and interaction rules |
| [Deployment](DEPLOYMENT.md) | Operators | Build and deploy instructions |
| [Operations](OPERATIONS.md) | Operators | Day-two runbook and recovery |
| [Security](SECURITY.md) | Users, operators | Security model and data handling |
| [Security review](SECURITY_REVIEW.md) | Security, engineering | Review scope, controls, and residual risk |
| [Code quality](CODE_QUALITY.md) | Contributors | Quality characteristics and debt register |
| [Testing](TESTING.md) | Contributors, reviewers | Automated and manual test plan |
| [Contributing](CONTRIBUTING.md) | Contributors | Change workflow and review checklist |
| [Contest demo](DEMO.md) | Presenters | Reliable live and fallback demo scripts |
| [Judging map](JUDGING.md) | Judges, presenters | Evidence mapped to scoring criteria |
| [Limitations](LIMITATIONS.md) | Everyone | Honest current boundaries |
| [Roadmap](ROADMAP.md) | Product, engineering | Prioritised future work |

## Source-of-truth hierarchy

When documentation and implementation disagree, resolve the conflict in this
order:

1. route handlers and library code under `apps/web/app/`, `apps/web/lib/`,
   `packages/core/src/` and `packages/storage/src/`;
2. automated tests under `apps/web/tests/`, `packages/core/tests/` and
   `packages/storage/tests/`;
3. deployment files (`Dockerfile`, `docker-compose.yml`, `.env.example`);
4. this documentation set.

Note that the code defaults and the Compose defaults differ on purpose:
`QUOTEREADY_STORAGE_DRIVER`, `QUOTEREADY_BLOB_DRIVER` and
`QUOTEREADY_PERSIST_UPLOADS` default to `json`, `fs` and unset in code, but to
`postgres`, `s3` and `true` in `docker-compose.yml` and `.env.example`. When a
document states a default, it must say which of the two it means.

Update the relevant documentation in the same change whenever a public
contract, security limit, data field, workflow, or deployment value changes.

## Documentation conventions

- Commands are written from the repository root unless a preceding `cd`
  changes the working directory.
- API paths are relative to the QuoteReady Studio origin.
- Sizes use binary units where the implementation does (`KiB`, `MiB`).
- Price values are EUR planning ranges, never quotations.
- A route marked **available in factory** means every operation has a matching
  enabled machine; it does not guarantee scheduling or production approval.
- "The Zoo agent" means Zoo's ML copilot reached over
  `wss://api.zoo.dev/ws/ml/copilot`; the three prompts that use it are named
  explicitly where the distinction matters.
- Mermaid diagrams are followed by prose descriptions so their meaning is
  available without rendering the diagram.
- Markdown in this repository is **not** covered by Prettier, so documentation is
  hand-formatted to roughly 80 columns.
