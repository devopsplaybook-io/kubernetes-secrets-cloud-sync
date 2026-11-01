# Kubernetes Secrets Cloud Sync - Agent Instructions

## Project Overview

A TypeScript service that syncs secrets from cloud providers (Alibaba Cloud KMS, AWS Secrets Manager, Restic snapshots) into Kubernetes secrets. It watches namespace annotations to determine which secrets to sync, runs an initial sync on startup, then periodically on a cron schedule. Can also run as a one-shot job.

## Project Structure

```
kubernetes-secrets-cloud-sync/
  src/
    App.ts                      # Entry point: startup, cron scheduling, source init
    Api.ts                      # HTTP API (status/manual sync) + in-memory SyncStatus
    Config.ts                   # Configuration loader (config.json + env vars)
    KubernetesClient.ts         # Kubernetes API: namespace scanning, secret CRUD
    SecretSync.ts               # Sync orchestrator: ties sources + k8s client together
    OTelContext.ts              # OpenTelemetry singleton (tracer, meter, logger)
    types.ts                    # Shared interfaces and type aliases
    declarations.d.ts           # Type declarations for Alibaba Cloud SDKs
    sources/
      SecretSource.ts           # SecretSource interface + BaseSecretSource abstract class
      AlibabaKmsSource.ts       # Alibaba Cloud KMS implementation
      AwsSecretsManagerSource.ts# AWS Secrets Manager implementation
      ResticSource.ts           # Restic snapshot-based secret source
  config.json                   # Default runtime configuration
  Dockerfile                    # Three-stage build (node:26-alpine + restic CLI, non-root)
```

## Coding Conventions

- **Language**: TypeScript (strict mode enabled, ES2020 target, CommonJS modules)
- **Runtime**: Node.js 26
- **Build**: `tsc` compiles `src/` to `dist/` (build also type-checks spec files via `tsconfig.spec.json`)
- **Dev mode**: `tsx watch ./src/App.ts`
- **Tests**: Jest with `@swc/jest` transform (v8 coverage provider), spec files named `*.spec.ts` alongside source, run with `npm test`
- **Linting**: oxlint (recommended preset), run with `npm run lint`
- **Config loading**: `config.json` values overridable via environment variables (env takes precedence)
- **Secrets in logs**: Sensitive config values (access keys, passwords) must be logged as `********************`, never in plain text
- **Error handling**: All async operations must have try/catch with proper error logging. Caught errors re-thrown as new errors must preserve the original via `cause`

## Architecture

### Secret Source Pattern

Cloud providers implement the `SecretSource` interface:

1. `providerName` - matches the annotation suffix (e.g., `alibaba-kms`, `aws-secretsmanager`, `restic`)
2. `init()` - called once at startup to authenticate/initialize the client
3. `fetchSecret(secretName, options?)` - returns a `SecretFetchResult` with plaintext key-value data; `options.signal` is the cycle deadline signal and must abort in-flight work
4. `isAvailable()` - returns true only when all required config is present
5. `beginCycle(secretNames, options?)` / `endCycle()` - optional per-cycle hooks (Restic resolves its snapshot there); `beginCycle` receives the same abort signal

New providers extend `BaseSecretSource` which provides `validateSecretData()` and `buildResult()` helpers.

### Kubernetes Annotation Contract

Namespaces are annotated with:

```
secrets.cloudsync.devopsplaybook.io/<provider-name>: <comma-separated-secret-names>
```

Multiple providers per namespace are supported via multiple annotations. Secret names in annotations map to cloud provider secret identifiers.

### Sync Flow

Every cycle runs under a deadline (`SYNC_CYCLE_TIMEOUT_SECONDS`) enforced by an
`AbortController` whose signal is propagated to namespace listing, source
`beginCycle`/`fetchSecret`, Kubernetes writes and orphan deletions. Work still
running when the deadline fires is aborted, the cycle counts one error, sets
`deadlineExceeded`, and `jobExitCode()` exits 1.

1. `KubernetesClient.getNamespaceSyncRequests()` - lists all namespaces, parses sync annotations
2. `SecretSync` pre-collects the union of requested secrets per provider and per-namespace upsert targets; colliding names are skipped (others continue), and each unique `(provider, secret)` is fetched exactly once per cycle
3. Providers that are not registered in the annotation, or registered but unavailable, are **not** silently skipped: each one is logged distinctly, added to `unknownProviders` / `unavailableProviders`, marks the namespace as failed and counts an error, so the run cannot report success and the job exits non-zero. A secret missing from an available provider is logged separately as a not-found and counts as a fetch failure.
4. Sources that implement `beginCycle(secretNames, options)` are called once per cycle with the union of names (Restic resolves its snapshot there); `SecretSync` applies bounded `SYNC_FETCH_CONCURRENCY` for fetching and `SYNC_WRITE_CONCURRENCY` for Kubernetes writes, with per-item error isolation; `endCycle()` always runs in `finally`
5. `KubernetesClient.upsertSecret()` - GET the Secret, enforce the instance-aware ownership guard (see below), then create or patch with an RFC 6902 JSON Patch. Per-key `add`/`remove` operations touch only labels/annotations this controller owns, so concurrent writers of other keys are not clobbered; the patch starts with `test /metadata/resourceVersion` so a Secret changed since the GET fails with 409. On conflict the client re-reads, re-asserts ownership and retries the patch once. Both the `cloudsync.devopsplaybook.io/data-hash` annotation and the actual data are compared first: unchanged Secrets are not written, metadata-only changes produce a metadata-only patch, and a payload change patches `data` together with the new hash. Legacy Secrets without a `data-hash` annotation only get metadata patched on the first cycle.
6. Managed secrets are labeled with `app.kubernetes.io/managed-by=kubernetes-secrets-cloud-sync` and `cloudsync.devopsplaybook.io/instance=<id>`; the original cloud identifier is stored in the `cloudsync.devopsplaybook.io/source-name` annotation and the payload hash in `cloudsync.devopsplaybook.io/data-hash`
7. Orphan cleanup (when enabled) deletes only Secrets of this instance (`managed-by` + `instance` labels) no longer referenced by any annotation, honoring `ORPHAN_CLEANUP_DRY_RUN` and `ORPHAN_CLEANUP_MAX_DELETIONS`. Hitting the maximum aborts cleanup, counts an error and reports `cleanupAborted` instead of a silent success

### Kubernetes request retries and timeouts

All Kubernetes calls run through `withRetry()` (`KubernetesClient.ts`) with a
per-attempt `AbortController` bounded by `K8S_REQUEST_TIMEOUT_MS`. Idempotent
operations (GET/PATCH/DELETE) retry up to `K8S_RETRY_MAX_ATTEMPTS` on 429, 5xx,
network errors and timeouts, with jittered exponential backoff honoring
`Retry-After`; 4xx (including 409, handled separately) are never retried and
`create` is never retried. Timeouts surface as `KubernetesRequestTimeoutError`
(`name = "TimeoutError"`, counted as retryable).

### Startup

`App.main()` installs the cron schedule (node-cron `noOverlap: true`) **before**
the initial sync, so a stalled initial sync cannot prevent future cycles. A
`SingleFlightRunner` makes a cron tick share the in-flight run instead of
starting a second one. In job mode the process runs one cycle and exits; the
exit code comes from `jobExitCode()` (`App.ts`): `1` when listing namespaces
failed, when the cycle deadline was exceeded, when
`errors > SYNC_ALLOWED_PARTIAL_FAILURES`, or when secrets were requested but
none could be fetched. An invalid `SYNC_CRON_SCHEDULE` fails startup before any
source is initialized.

Overlap protection is per process: run a single replica (CronJobs keep
`concurrencyPolicy: Forbid`).

In deployment mode the HTTP API (`src/Api.ts`) starts on
`API_HOST`/`API_PORT` before cron scheduling and the initial sync, so probes
succeed while the first cycle runs. `POST /api/sync` uses the same
`SingleFlightRunner`, so a manual trigger during a cron/initial run returns
409 instead of starting a second cycle. Job mode never listens.

`SIGTERM`/`SIGINT` stop the scheduler, close the HTTP server, drain the
in-flight run (`SingleFlightRunner.whenIdle`) bounded by
`SHUTDOWN_GRACE_PERIOD_SECONDS`, shut down logger/tracer/meter, then exit. Job
mode awaits the same shutdown before `process.exit`.

Configuration reload (deployment mode) polls `config.json` every 10s with a 1s
debounce, serializes reloads, and reschedules cron when
`SYNC_CRON_SCHEDULE` changes. Settings bound at construction time
(`JOB_MODE`, prefixes, cloud regions/credentials, `LOG_LEVEL`, Kubernetes
request timeout/retry settings, AWS SDK HTTP timeouts, all `OPENTELEMETRY_*`)
only log a value-free restart warning. The watcher is not installed in job
mode.

### Observability

`OTelStartSpan()`/`OTelEndSpan()` (`src/OTelContext.ts`) create explicit spans
parented by argument (not by ambient context): one `sync-run` root span per
cycle, plus `source-begin-cycle`, `source-fetch`, `source-end-cycle` and one
span per Kubernetes API call. HTTP requests under `/api` get server spans from
`@devopsplaybook.io/otel-utils-fastify` (registered without a meter);
`GET /api/status` is excluded to keep probe noise out of traces. Do **not**
add custom metrics. Restic output is
sanitized by `src/Redaction.ts` before it reaches logs or errors, and
`RESTIC_REPOSITORY` is masked in the config dump.

### Secret Naming

`SECRET_NAME_PREFIX` + cloud identifier is normalized into a valid DNS-1123
subdomain (lowercase, `-`/`.`, <= 253 chars; long names get a deterministic
`-<hash8>` suffix). Already-valid names are unchanged. The raw identifier is
kept in the `cloudsync.devopsplaybook.io/source-name` annotation; the
`cloudsync.devopsplaybook.io/secret-name` label is only set when the identifier
is a valid label value (<= 63 chars). `src/SecretName.ts` holds the pure helpers.

### Ownership, Validation and Binary Payloads

- Never overwrite a Secret whose `app.kubernetes.io/managed-by` label is not
  `kubernetes-secrets-cloud-sync`; adoption requires
  `cloudsync.devopsplaybook.io/adopt: "true"`. Ownership is also
  instance-aware: a Secret carrying another
  `cloudsync.devopsplaybook.io/instance` is refused unless adopted, while a
  Secret without the instance label (created before instance scoping) is
  treated as owned and has the label backfilled. Foreign labels/annotations are
  preserved on update.
- `BaseSecretSource.validateSecretData()` rejects invalid keys
  (`[-._a-zA-Z0-9]+`), nested objects/arrays and payloads above 1 MiB; scalars
  are stringified, `null`/`undefined` skipped.
- AWS `SecretBinary` and Alibaba `secretDataType=binary` are stored base64 under
  the `binary` key; Alibaba KMS calls retry transient errors (3 attempts,
  exponential jitter).
- Restic resolves one snapshot per cycle (`restic snapshots --json`, filtered by
  the optional `RESTIC_HOST`/`RESTIC_TAG`/`RESTIC_SNAPSHOT_PATH`, newest by
  time) and streams each file with `restic dump <id> /<path>/<name>.json`; no
  restore and no temporary plaintext files (per-secret dump is deliberate, see
  README). The newest snapshot must be at most
  `RESTIC_MAX_SNAPSHOT_AGE_SECONDS` old (default 48 h, `0` disables); otherwise
  the restic source fails the cycle and no stale Secret is written. Names and
  `RESTIC_PATH` are validated (letters/digits/`.`, `_`, `-`, `/`; no `..`,
  empty segments or leading/trailing slash). stdout/stderr are decoded with a
  streaming UTF-8 decoder and capped at `RESTIC_MAX_OUTPUT_BYTES` per stream.
  Each invocation runs `detached` and the whole process group is killed with
  `SIGKILL` after `RESTIC_TIMEOUT_SECONDS` or on abort. Only transient failures
  (timeouts, exit 11 lock, transient spawn errors, network-style stderr) are
  retried `RESTIC_RETRIES` times; auth/config/usage errors fail fast.

### Trust Model

The controller holds account-wide cloud credentials and a ClusterRole over all
Secrets: anyone who can patch a namespace's `secrets.cloudsync.devopsplaybook.io/*`
annotations can copy any readable cloud secret into that namespace. This is
documented in the README; there is no built-in per-namespace allow-list —
restrict annotation edits with RBAC/admission policies and scope credentials.

## Configuration

All config is loaded by `Config.reload()` in this priority order:

1. Environment variables (highest priority)
2. `config.json` file
3. Class defaults

Key configuration values:

- `SYNC_CRON_SCHEDULE` - cron expression for periodic sync (default: `*/5 * * * *`)
- `JOB_MODE` - run once and exit (for Kubernetes Job/CronJob usage)
- `ANNOTATION_PREFIX` - namespace annotation prefix
- `SECRET_NAME_PREFIX` - prefix added to Kubernetes secret names
- `DELETE_ORPHANED_SECRETS` - enable orphan managed secret cleanup
- `ORPHAN_CLEANUP_DRY_RUN` - preview orphan deletions without deleting (default: `false`)
- `ORPHAN_CLEANUP_MAX_DELETIONS` - abort cleanup above this many orphans (default: `50`)
- `SYNC_FETCH_CONCURRENCY` - max concurrent cloud fetches (default: `4`, clamped 1-32)
- `SYNC_WRITE_CONCURRENCY` - max concurrent Kubernetes writes (default: `4`, clamped 1-32)
- `SYNC_ALLOWED_PARTIAL_FAILURES` - job-mode error budget before exit 1 (default: `0`, clamped 0-10000)
- `SYNC_CYCLE_TIMEOUT_SECONDS` - per-cycle deadline; in-flight work is aborted when it fires (default: `300`, clamped 1-7200)
- `SHUTDOWN_GRACE_PERIOD_SECONDS` - how long shutdown waits for the in-flight cycle (default: `15`, clamped 1-300)
- `K8S_REQUEST_TIMEOUT_MS` - per-attempt Kubernetes request timeout (default: `30000`, clamped 1000-600000, restart-only)
- `K8S_RETRY_MAX_ATTEMPTS` - attempts for idempotent Kubernetes calls on 429/5xx/network/timeout (default: `3`, clamped 1-10, restart-only)
- `AWS_SECRETSMANAGER_CONNECT_TIMEOUT_MS` - AWS SDK connection timeout (default: `10000`, restart-only)
- `AWS_SECRETSMANAGER_REQUEST_TIMEOUT_MS` - AWS SDK request timeout (default: `30000`, restart-only)
- `API_PORT` - HTTP API listen port, deployment mode only (default: `8080`, clamped 1-65535, restart-only)
- `API_HOST` - HTTP API listen address (default: `0.0.0.0`, blank falls back to the default, restart-only)
- `RESTIC_TIMEOUT_SECONDS` - per-invocation restic timeout, whole process group killed (default: `120`)
- `RESTIC_RETRIES` - transient restic failure retries (default: `2`)
- `RESTIC_HOST` / `RESTIC_TAG` / `RESTIC_SNAPSHOT_PATH` - optional `restic snapshots` filters (default: empty = all snapshots). `RESTIC_SNAPSHOT_PATH` filters snapshots by backed-up path; `RESTIC_PATH` selects the folder inside a snapshot for `dump`
- `RESTIC_MAX_SNAPSHOT_AGE_SECONDS` - newest snapshot must be younger than this; the restic source fails the cycle when stale (default: `172800` = 48 h, `0` disables)
- `RESTIC_MAX_OUTPUT_BYTES` - per-stream stdout/stderr cap for one invocation (default: `8388608` = 8 MiB, clamped 65536-268435456)
- Provider-specific: region, credentials for Alibaba KMS / AWS Secrets Manager / Restic

Boolean config values accept `true`, `"true"`, or `"1"` (string or boolean).

## Docker

- Three-stage build on `node:26-alpine`: builder compiles TypeScript, a
  `prod-deps` stage runs `npm ci --omit=dev`, and the runtime image copies only
  `dist` + production `node_modules` (no devDependencies)
- Runtime image installs the `restic` CLI and runs as `USER node` (uid/gid 1000)
- Docker `HEALTHCHECK` calls `GET /api/status` on `${API_PORT:-8080}`; skipped
  in job mode (`JOB_MODE`), which exits without listening. Kubernetes ignores
  image healthchecks and uses its own probes
- Runtime command: `node dist/App.js`

## Post-Change Validation

After any code change, run:

```bash
npm run build        # TypeScript compilation (strict mode)
npm run lint         # oxlint check
npm test             # Jest tests with coverage (thresholds enforced)
npm audit --omit=dev # production dependencies must be vulnerability-free
```

All four must pass. Add tests for new code paths, especially new secret source
implementations and sync logic changes.
