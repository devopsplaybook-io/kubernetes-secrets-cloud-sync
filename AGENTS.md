# Kubernetes Secrets Cloud Sync - Agent Instructions

## Project Overview

A TypeScript service that syncs secrets from cloud providers (Alibaba Cloud KMS, AWS Secrets Manager, Restic snapshots) into Kubernetes secrets. It watches namespace annotations to determine which secrets to sync, runs an initial sync on startup, then periodically on a cron schedule. Can also run as a one-shot job.

## Project Structure

```
kubernetes-secrets-cloud-sync/
  src/
    App.ts                      # Entry point: startup, cron scheduling, source init
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
  Dockerfile                    # Multi-stage build (node:24-alpine + restic CLI)
```

## Coding Conventions

- **Language**: TypeScript (strict mode off, ES2020 target, CommonJS modules)
- **Runtime**: Node.js 24
- **Build**: `tsc` compiles `src/` to `dist/`
- **Dev mode**: `ts-node-dev ./src/App.ts`
- **Tests**: Jest with `ts-jest`, spec files named `*.spec.ts` alongside source, run with `npm test`
- **Linting**: ESLint with `typescript-eslint` (strict + stylistic configs), spec files ignored
- **Config loading**: `config.json` values overridable via environment variables (env takes precedence)
- **Secrets in logs**: Sensitive config values (access keys, passwords) must be logged as `********************`, never in plain text
- **Error handling**: All async operations must have try/catch with proper error logging. Caught errors re-thrown as new errors must preserve the original via `cause`

## Architecture

### Secret Source Pattern

Cloud providers implement the `SecretSource` interface:

1. `providerName` - matches the annotation suffix (e.g., `alibaba-kms`, `aws-secretsmanager`, `restic`)
2. `init()` - called once at startup to authenticate/initialize the client
3. `fetchSecret(secretName)` - returns a `SecretFetchResult` with plaintext key-value data
4. `isAvailable()` - returns true only when all required config is present

New providers extend `BaseSecretSource` which provides `validateSecretData()` and `buildResult()` helpers.

### Kubernetes Annotation Contract

Namespaces are annotated with:

```
secrets.cloudsync.devopsplaybook.io/<provider-name>: <comma-separated-secret-names>
```

Multiple providers per namespace are supported via multiple annotations. Secret names in annotations map to cloud provider secret identifiers.

### Sync Flow

1. `KubernetesClient.getNamespaceSyncRequests()` - lists all namespaces, parses sync annotations
2. For each namespace, `SecretSync` iterates annotations, calls `source.fetchSecret()` for each secret name
3. `KubernetesClient.upsertSecret()` - replace-then-create pattern (404 fallback to create)
4. Managed secrets are labeled with `app.kubernetes.io/managed-by=kubernetes-secrets-cloud-sync`
5. Orphan cleanup (when enabled) deletes managed secrets no longer referenced by any annotation

### Secret Naming

Kubernetes secret names are prefixed with `SECRET_NAME_PREFIX` (default: `cloudsync-`). A secret named `db-password` in annotations becomes `cloudsync-db-password` in Kubernetes.

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
- Provider-specific: region, credentials for Alibaba KMS / AWS Secrets Manager / Restic

Boolean config values accept `true`, `"true"`, or `"1"` (string or boolean).

## Docker

- Multi-stage build: `node:24-alpine` builder compiles TypeScript, runtime stage includes `restic` CLI
- Runtime command: `node dist/App.js`
- Restic binary is installed in the runtime image for the Restic secret source

## Post-Change Validation

After any code change, run:

```bash
npm run build    # TypeScript compilation
npm run lint     # ESLint check
npm test         # Jest tests with coverage
```

All three must pass. Add tests for new code paths, especially new secret source implementations and sync logic changes.
