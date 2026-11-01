# kubernetes-secrets-cloud-sync

A Kubernetes controller that synchronizes secrets from cloud providers into Kubernetes namespaces based on annotations.

## Security and trust model

**This controller is a highly privileged component.** It holds cloud credentials
with account-wide read access (Alibaba KMS, AWS Secrets Manager, Restic) and a
ClusterRole that grants access to Secrets in every namespace.

Anyone able to patch a namespace's sync annotations
(`secrets.cloudsync.devopsplaybook.io/*`) can ask the controller to copy any
secret readable by those credentials — including by guessing its name — into
that namespace, where they can read it. Do not grant namespace-annotation write
access to untrusted workloads.

Recommendations:

- Restrict who may set the annotation prefix: use RBAC on namespaces and/or an
  admission policy (for example a Kubernetes `ValidatingAdmissionPolicy`) so
  that only trusted subjects may create or update
  `secrets.cloudsync.devopsplaybook.io/*` annotations.
- Scope cloud credentials as narrowly as possible (per-tenant or per-namespace
  credentials, one controller instance per trust boundary).
- Review the ClusterRole: orphan cleanup requires list access to Secrets across
  namespaces; restrict it if that risk outweighs the benefit.
- The HTTP API (deployment mode) has no built-in authentication. Keep the
  listener cluster-internal (ClusterIP Service and/or a NetworkPolicy) and
  never expose `POST /api/sync` publicly: anyone who can reach it can start a
  sync.

No per-namespace allow-list is built into the controller: isolation relies on
Kubernetes RBAC and admission policies.

## How It Works

1. The service runs inside a Kubernetes cluster and periodically scans all namespaces
2. It looks for annotations on namespaces that specify which cloud secrets to sync
3. It fetches the specified secrets from the configured cloud providers
   (Alibaba KMS, AWS Secrets Manager and Restic are supported)
4. It creates or updates Kubernetes Secret resources in the annotated namespaces

## Namespace Annotation Convention

Annotations follow the pattern:

```
secrets.cloudsync.devopsplaybook.io/<provider>: "<secret-name-1>,<secret-name-2>"
```

### Example

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-app
  annotations:
    secrets.cloudsync.devopsplaybook.io/alibaba-kms: "my-app-database,my-app-api-config"
    secrets.cloudsync.devopsplaybook.io/aws-secretsmanager: "prod/my-app/database,prod/my-app/api-keys"
    secrets.cloudsync.devopsplaybook.io/restic: "shared-certificates"
```

This will sync:

- `my-app-database` and `my-app-api-config` from **Alibaba KMS**
- `prod/my-app/database` and `prod/my-app/api-keys` from **AWS Secrets Manager**
- `shared-certificates` from **Restic**

All fetched secrets become Kubernetes Secret resources in the `my-app` namespace, each prefixed with the configured `SECRET_NAME_PREFIX` (default: `cloudsync-`).

### Secret naming

The cloud identifier does not need to be a valid Kubernetes name: the controller
normalizes `SECRET_NAME_PREFIX` + identifier into a DNS-1123 subdomain
(lowercase alphanumerics, `-` and `.`, at most 253 characters):

- lowercase; invalid characters are replaced with `-`; repeated separators are
  collapsed and leading/trailing separators are trimmed;
- names longer than 253 characters are truncated and suffixed with
  `-<8 hex chars>` derived from a SHA-256 hash (deterministic);
- already-valid names are unchanged, so existing Secrets are not renamed.

| Cloud identifier       | Kubernetes Secret name            |
| ---------------------- | --------------------------------- |
| `my-app-database`      | `cloudsync-my-app-database`       |
| `prod/my-app/database` | `cloudsync-prod-my-app-database`  |
| `PROD/My-App/DB`       | `cloudsync-prod-my-app-db`        |

The original identifier is always stored in the
`cloudsync.devopsplaybook.io/source-name` annotation. The
`cloudsync.devopsplaybook.io/secret-name` label is set only when the identifier
is also a valid label value (at most 63 characters), so it is omitted for names
such as `prod/my-app/database`.

If two identifiers in the same namespace normalize to the same Kubernetes
Secret name, the controller logs an error and skips both; the rest of the
namespace still syncs.

### Ownership and adoption

Every Secret created by the controller is labeled
`app.kubernetes.io/managed-by=kubernetes-secrets-cloud-sync` (plus an instance
label, see [Orphan cleanup](#orphan-cleanup)). Before writing, the controller
reads the existing Secret: a Secret that is not managed by the controller is
**never overwritten** and that secret fails to sync with an error in the logs.

To hand an existing Secret over to the controller, add the adoption annotation:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudsync-my-secret
  annotations:
    cloudsync.devopsplaybook.io/adopt: "true"
```

On adoption, and on every later update, labels and annotations not owned by the
controller are preserved, while the `data` section is replaced by the cloud
payload (stale keys are removed). Updates are JSON Patch operations guarded by a
`resourceVersion` test, so a concurrent writer is detected (the controller
re-reads and retries once) instead of being silently overwritten.

Ownership includes the instance label: a Secret managed by another controller
instance (different `ANNOTATION_PREFIX`) is refused unless it carries the same
adoption annotation. Secrets written before instance tracking existed (no
`instance` label) stay owned and get the label backfilled on their next write.

### Payload validation and binary secrets

Before writing a Secret, each provider validates the payload:

- data keys must match `[-._a-zA-Z0-9]+`; invalid keys fail the whole Secret
  with an error naming them (no partial write);
- string, number and boolean values are stringified; `null`/`undefined` values
  are skipped; nested objects and arrays are rejected — store JSON as a string
  instead;
- payloads above the Kubernetes 1 MiB Secret limit are rejected.

Binary secrets are supported deliberately: an AWS `SecretBinary` payload and an
Alibaba KMS secret with `secretDataType=binary` are stored base64-encoded under
the data key `binary` (never UTF-8 decoded and never JSON parsed).

### Created Secrets

For a KMS secret named `myapplication` containing:

```json
{
  "LLM_MODEL": "gpt-4",
  "LLM_API_KEY": "sk-...",
  "LLM_API_URL": "https://api.openai.com/v1"
}
```

A Kubernetes Secret named `cloudsync-myapplication` is created with each JSON key as a separate data entry.

## Supported Cloud Providers

| Provider            | Annotation Suffix    | Status    |
| ------------------- | -------------------- | --------- |
| Alibaba KMS         | `alibaba-kms`        | Supported |
| AWS Secrets Manager | `aws-secretsmanager` | Supported |
| Restic              | `restic`             | Supported |

The architecture is designed to be extensible. Additional providers can be added by implementing the `SecretSource` interface.

### Restic Provider

Each sync cycle resolves the **newest snapshot** of the configured restic
repository once (`restic snapshots --json`), then streams every requested
`<secret-name>.json` file (optionally under `RESTIC_PATH`) from that snapshot
with `restic dump`. Every unique secret is fetched once per cycle, all secrets
of a cycle come from the same snapshot, no full-snapshot restore is performed
and no plaintext copy is written to disk. Each file must contain a flat JSON
object whose keys/values become the Kubernetes Secret entries.

Secret names and `RESTIC_PATH` are validated before any restic invocation:
only letters, digits, `.`, `_`, `-` and `/` are accepted, and leading/trailing
slashes, empty segments and `..` segments are rejected (they could otherwise
escape the expected path or turn into glob patterns).

Every restic invocation is bounded by `RESTIC_TIMEOUT_SECONDS` (default `120`)
and killed with `SIGKILL` when it exceeds it. Transient failures are retried
`RESTIC_RETRIES` times (default `2`) with exponential backoff; a missing
`restic` binary and invalid names are not retried.

Example file `feedwatcher.json` inside the restic snapshot:

```json
{
  "LLM_MODEL": "gpt-4",
  "LLM_API_KEY": "sk-..."
}
```

With annotation `secrets.cloudsync.devopsplaybook.io/restic: "feedwatcher"`, a Kubernetes Secret named `cloudsync-feedwatcher` is created.

The `restic` CLI must be available on the container `PATH` (included in the provided Docker image). Backend-specific environment variables (e.g. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` for S3-backed repos) should be provided via the pod environment and will be forwarded to the `restic` process.

### Change detection

Each managed Secret carries a `cloudsync.devopsplaybook.io/data-hash`
annotation (SHA-256 of the canonical payload, independent of key order). On
every cycle the controller compares both the hash and the actual Secret data:

- payload and metadata unchanged: no API write at all;
- only metadata changed (labels/annotations): a metadata-only patch, the
  `data` field is left untouched;
- payload changed (even when the stored hash says otherwise): `data` is
  patched together with the new hash.

Secrets created before this behaviour existed have no `data-hash` annotation:
the first cycle after the upgrade only patches their metadata, and from the
second cycle on unchanged Secrets are no longer written.

Fetching and writing are bounded by `SYNC_FETCH_CONCURRENCY` and
`SYNC_WRITE_CONCURRENCY` (default `4` each), so a cycle no longer runs
hundreds of cloud calls strictly sequentially.

### Sync cycle deadline and retries

`SYNC_CYCLE_TIMEOUT_SECONDS` (default `300`) bounds a whole cycle. When it
expires, the controller aborts the in-flight provider calls and Kubernetes
requests, stops scheduling more work, skips orphan cleanup, and reports the run
as failed (`deadlineExceeded`) so job mode exits non-zero.

Individual Kubernetes requests are bounded by `K8S_REQUEST_TIMEOUT_MS` (default
`30000`). Idempotent calls (GET, PATCH, DELETE) retry up to
`K8S_RETRY_MAX_ATTEMPTS` (default `3`) on `429` and `5xx` responses and on
transient network errors, using exponential backoff with jitter and honoring a
`Retry-After` header (capped at 30s). Creates are never retried, so a
partially-applied write is not duplicated. `409` conflicts keep their own
re-read-and-retry-once path, separate from the transient retry policy.

AWS Secrets Manager uses the SDK's `NodeHttpHandler` with
`AWS_SECRETSMANAGER_CONNECT_TIMEOUT_MS` (default `10000`) and
`AWS_SECRETSMANAGER_REQUEST_TIMEOUT_MS` (default `30000`). Alibaba KMS and
Restic already enforce their own per-call timeouts and retries.

A provider that is annotated but not registered, or registered but not
available (missing credentials), is treated as a configuration failure: the
annotation is skipped, the namespace is marked failed, and the occurrence is
counted in `errors`, so the job exits non-zero and `/api/status` reports
`partial` (or `failure`). This is distinct from a secret that the provider
reports as not found, which is logged as a per-secret error.

On `SIGTERM`/`SIGINT` the service waits up to `SHUTDOWN_GRACE_PERIOD_SECONDS`
(default `15`) for the in-flight cycle before exiting.


## Orphan cleanup

When `DELETE_ORPHANED_SECRETS` is enabled, Secrets managed by this controller
instance that are no longer referenced by any namespace annotation are deleted.
Cleanup is instance-scoped: created Secrets carry
`cloudsync.devopsplaybook.io/instance=<id>` (8 hex characters derived from
`ANNOTATION_PREFIX`), and only Secrets with that label are cleanup candidates.
A second installation, or a prefix change, therefore never deletes the other
instance's Secrets. Secrets created before this label existed stop being
auto-deleted (safe default).

Safety controls:

- `ORPHAN_CLEANUP_DRY_RUN=true` logs the candidates and deletes nothing.
- `ORPHAN_CLEANUP_MAX_DELETIONS` (default `50`): when more orphans than this
  are found, nothing is deleted, an error is logged, and the run is marked with
  `cleanupAborted` so job mode and `/api/status` do not report success.
- A preview of the candidates (up to 20, plus a count of the rest) is logged
  before any deletion.

## Configuration

Configuration can be set via `config.json` or environment variables:

| Key                                    | Default                               | Description                                  |
| -------------------------------------- | ------------------------------------- | -------------------------------------------- |
| `SYNC_CRON_SCHEDULE`                   | `*/5 * * * *`                         | Cron schedule for periodic sync              |
| `JOB_MODE`                             | `false`                               | Run sync once on startup and exit            |
| `ANNOTATION_PREFIX`                    | `secrets.cloudsync.devopsplaybook.io` | Annotation key prefix                        |
| `SECRET_NAME_PREFIX`                   | `cloudsync-`                          | Prefix for created Kubernetes secret names   |
| `DELETE_ORPHANED_SECRETS`              | `false`                               | Delete managed secrets no longer annotated   |
| `ORPHAN_CLEANUP_DRY_RUN`               | `false`                               | Preview orphan deletions without deleting    |
| `ORPHAN_CLEANUP_MAX_DELETIONS`         | `50`                                  | Abort cleanup above this many orphans        |
| `SYNC_FETCH_CONCURRENCY`               | `4`                                   | Max concurrent cloud secret fetches (1-32)   |
| `SYNC_WRITE_CONCURRENCY`               | `4`                                   | Max concurrent Kubernetes Secret writes      |
| `SYNC_ALLOWED_PARTIAL_FAILURES`        | `0`                                   | Job-mode error budget (0-10000)              |
| `SYNC_CYCLE_TIMEOUT_SECONDS`           | `300`                                 | Whole-cycle deadline (1-7200)                |
| `SHUTDOWN_GRACE_PERIOD_SECONDS`        | `15`                                  | Max wait for an in-flight cycle on shutdown  |
| `K8S_REQUEST_TIMEOUT_MS`               | `30000`                               | Per-request Kubernetes timeout               |
| `K8S_RETRY_MAX_ATTEMPTS`               | `3`                                   | Attempts for idempotent Kubernetes calls     |
| `AWS_SECRETSMANAGER_CONNECT_TIMEOUT_MS`| `10000`                               | AWS SDK connect timeout                      |
| `AWS_SECRETSMANAGER_REQUEST_TIMEOUT_MS`| `30000`                               | AWS SDK request timeout                      |
| `ALIBABA_KMS_REGION`                   |                                       | Alibaba Cloud region                         |
| `ALIBABA_KMS_ACCESS_KEY_ID`            |                                       | Alibaba Cloud access key ID                  |
| `ALIBABA_KMS_ACCESS_KEY_SECRET`        |                                       | Alibaba Cloud access key secret              |
| `AWS_SECRETSMANAGER_REGION`            |                                       | AWS region (enables AWS Secrets Manager)     |
| `AWS_SECRETSMANAGER_ACCESS_KEY_ID`     |                                       | AWS access key ID (optional, IRSA preferred) |
| `AWS_SECRETSMANAGER_SECRET_ACCESS_KEY` |                                       | AWS secret access key (optional)             |
| `RESTIC_REPOSITORY`                    |                                       | Restic repository URL (enables restic)       |
| `RESTIC_PASSWORD`                      |                                       | Restic repository password                   |
| `RESTIC_PATH`                          |                                       | Optional sub-folder inside the snapshot      |
| `RESTIC_OPTIONS`                       |                                       | Extra CLI args appended to every restic call |
| `RESTIC_TIMEOUT_SECONDS`               | `120`                                 | Per-invocation restic timeout (SIGKILL)      |
| `RESTIC_RETRIES`                       | `2`                                   | Retries for transient restic failures        |
| `LOG_LEVEL`                            | `info`                                | Log level                                    |
| `API_HOST`                             | `0.0.0.0`                             | HTTP API listen address (deployment mode)    |
| `API_PORT`                             | `8080`                                | HTTP API port (validation, 1-65535)          |

### Configuration reload

In deployment (long-lived) mode the service polls `config.json` every
10 seconds and reloads it once changes settle (1 second debounce). Reloads are
serialized, so overlapping file events never run concurrently.

Applied on the next cycle without a restart:

- `SYNC_CRON_SCHEDULE` (the cron job is rescheduled in place; an invalid
  expression is rejected and the previous schedule stays active);
- `DELETE_ORPHANED_SECRETS`, `ORPHAN_CLEANUP_DRY_RUN`,
  `ORPHAN_CLEANUP_MAX_DELETIONS`;
- `SYNC_FETCH_CONCURRENCY`, `SYNC_WRITE_CONCURRENCY`,
  `SYNC_ALLOWED_PARTIAL_FAILURES`, `SYNC_CYCLE_TIMEOUT_SECONDS`,
  `SHUTDOWN_GRACE_PERIOD_SECONDS`;
- `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `RESTIC_PATH`, `RESTIC_OPTIONS`,
  `RESTIC_TIMEOUT_SECONDS`, `RESTIC_RETRIES`.

Restart-only settings (`JOB_MODE`, `ANNOTATION_PREFIX`, `SECRET_NAME_PREFIX`,
`API_HOST`, `API_PORT`, `K8S_REQUEST_TIMEOUT_MS`, `K8S_RETRY_MAX_ATTEMPTS`,
cloud regions, credentials and HTTP timeouts, `LOG_LEVEL` and all
`OPENTELEMETRY_*` keys) are read once at startup. When a reload changes one of
them, the service logs a warning naming the key and asking for a restart;
values are never logged.

The watcher is skipped entirely in job mode, which exits after a single run.

An invalid `SYNC_CRON_SCHEDULE` at startup fails fast: the process logs the
expression and exits with code 1 instead of silently running without a
schedule.

### Job mode exit codes

`JOB_MODE=true` runs one sync and exits. The exit code is `1` when any of the
following is true, and `0` otherwise:

- listing namespaces failed (the run never got a work list);
- the cycle deadline (`SYNC_CYCLE_TIMEOUT_SECONDS`) was exceeded
  (`deadlineExceeded`);
- `errors > SYNC_ALLOWED_PARTIAL_FAILURES` (default `0`, i.e. any error fails
  the job); unavailable/unknown providers, aborted orphan cleanup above the
  deletion threshold, and per-secret failures all count as errors;
- secrets were requested but none could be fetched (`secrets > 0 &&
  succeededSecrets === 0`).

A one-line summary (namespaces, secrets, succeeded, errors, failed namespace
count and duration) is logged before exiting. Raise
`SYNC_ALLOWED_PARTIAL_FAILURES` only when a small, known number of permanent
failures should not fail the whole job.

## Observability

When `OPENTELEMETRY_COLLECTOR_HTTP_*` endpoints are configured, the service
exports traces and logs. Each cycle is wrapped in a `sync-run` span with
attributes for namespace/secret counts, successes, errors, failed namespaces,
duration and whether the namespace listing succeeded; child spans cover each
source `beginCycle`/`fetchSecret`/`endCycle` and every Kubernetes API call.
HTTP requests under `/api` are traced with `@devopsplaybook.io/otel-utils-fastify`
server spans; `/api/status` is excluded to keep probe traffic out of the
traces, and unmatched routes use a bounded span name. No custom metrics are
emitted: the Fastify plugin is registered without a meter.

On `SIGTERM`/`SIGINT` the service stops scheduling, waits for the in-flight
sync to finish and shuts the logger, tracer and meter down before exiting, so
buffered telemetry is flushed. In job mode the same shutdown happens before
`process.exit`.

Run a **single replica**. Overlap protection (`noOverlap` plus a single-flight
runner) only applies inside one process; two replicas would write the same
Secrets concurrently and could race on orphan cleanup. For CronJobs keep
`concurrencyPolicy: Forbid`.

### Log redaction

Secret values are never logged. Provider credentials and `RESTIC_PASSWORD`
are masked in the startup configuration dump, and `RESTIC_REPOSITORY` is
masked there as well. Restic output is sanitized before it reaches logs or
error messages: URL userinfo (`scheme://user:pass@host`) becomes
`scheme://***@host`, and the configured repository, password and
`RESTIC_OPTIONS` strings are replaced with `***`.

## API Endpoints

The HTTP API is available in **deployment mode only**. Job mode
(`JOB_MODE=true`) runs one sync and exits without listening. The server listens
on `API_HOST` (default `0.0.0.0`) and `API_PORT` (default `8080`); both are read
at startup, so changing them requires a restart.

The API is **unauthenticated**: keep it cluster-internal (ClusterIP Service
and/or a NetworkPolicy) and never expose `POST /api/sync` outside the cluster.

### `GET /api/status`

Readiness and diagnostics endpoint. It returns `200` with `status: "ok"` while
the configuration is valid and `503` with `status: "degraded"` when a critical
configuration value is invalid (an invalid `SYNC_CRON_SCHEDULE` introduced by
a hot reload, or a failed configuration reload). It also reports the last sync:

```json
{
  "status": "ok",
  "service": "kubernetes-secrets-cloud-sync",
  "version": "0.11.0",
  "mode": "deployment",
  "running": true,
  "uptimeSeconds": 12,
  "config": { "valid": true, "issues": [] },
  "scheduler": { "cron": "*/5 * * * *" },
  "sync": {
    "inFlight": false,
    "lastStart": "2026-10-23T18:00:00.000Z",
    "lastEnd": "2026-10-23T18:00:02.000Z",
    "lastOutcome": "success",
    "lastError": null,
    "lastResult": {
      "namespaces": 2,
      "secrets": 5,
      "succeededSecrets": 5,
      "errors": 0,
      "failedNamespaces": [],
      "namespaceListSucceeded": true,
      "durationMs": 2000
    }
  }
}
```

`sync.lastOutcome` is `success` for a clean run, `partial` when some operations
failed but data was synced, and `failure` when the namespace listing failed or
nothing requested could be fetched. `sync.inFlight` and the last-run fields are
informational: a failed sync does **not** change the status code, so a cloud
outage never causes a pod restart. The state is in-memory and resets when the
process restarts. Requests are traced, except `GET /api/status` itself (probe
noise), and no custom metrics are emitted.

### `POST /api/sync`

Starts a sync immediately and returns `202` with `{"status":"accepted"}`. The
sync runs through the same single-flight runner as cron ticks and the initial
sync, so it can never overlap with them; while a run is in progress the
endpoint returns `409` with `{"status":"already_running"}`. The request body is
ignored.

```bash
curl -s localhost:8080/api/status
curl -X POST localhost:8080/api/sync
```

### Kubernetes probes

The server starts before the initial sync and stays up while a sync is in
flight, so readiness can follow the status code. Recommended probes for the
Deployment:

```yaml
readinessProbe:
  httpGet:
    path: /api/status
    port: 8080
  periodSeconds: 10
livenessProbe:
  tcpSocket:
    port: 8080
  periodSeconds: 20
```

Liveness deliberately uses a TCP check: `GET /api/status` returns `503` for an
invalid configuration, and restarting the container cannot fix a configuration
error, so using the HTTP status for liveness would cause a restart loop.

## Deployment to Kubernetes

The service is designed to run inside a Kubernetes cluster as a CronJob (job mode) or as a long-running Deployment.

### Required RBAC Permissions

Because the service scans all namespaces for annotations and creates secrets in arbitrary namespaces, it needs a **ClusterRole**. Below are the minimum required permissions:

The controller lists namespaces, reads (`get`) a Secret before writing and
updates it with a JSON `patch`; `update` is not used. Keep `list` for
namespaces and `get`, `list`, `create`, `patch`, `delete` for Secrets when
reviewing the deployed ClusterRole.

| Resource     | Verbs                                        | Reason                                                                |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------- |
| `namespaces` | `list`                                       | Scan all namespaces for sync annotations                              |
| `secrets`    | `get`, `list`, `create`, `patch`, `delete`   | Read for the ownership guard, create/patch synced secrets, list managed secrets for orphan cleanup, delete orphans |

### Full Deployment Example

Create the following manifests and apply them with `kubectl apply -k .` (via kustomize) or individually.

#### `namespace.yaml`

```yaml
kind: Namespace
apiVersion: v1
metadata:
  name: kubernetes-secrets-cloud-sync
  labels:
    name: kubernetes-secrets-cloud-sync
  annotations:
    # Optional: sync secrets into the tool's own namespace as well
    secrets.cloudsync.devopsplaybook.io/restic: "my-shared-secret"
```

#### `rbac.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubernetes-secrets-cloud-sync
  namespace: kubernetes-secrets-cloud-sync
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubernetes-secrets-cloud-sync
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["list"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "create", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubernetes-secrets-cloud-sync
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubernetes-secrets-cloud-sync
subjects:
  - kind: ServiceAccount
    name: kubernetes-secrets-cloud-sync
    namespace: kubernetes-secrets-cloud-sync
```

#### `cronjob.yaml`

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kubernetes-secrets-cloud-sync
  namespace: kubernetes-secrets-cloud-sync
  labels:
    app: kubernetes-secrets-cloud-sync
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: kubernetes-secrets-cloud-sync
        spec:
          serviceAccountName: kubernetes-secrets-cloud-sync
          containers:
            - image: your-registry/kubernetes-secrets-cloud-sync:latest
              name: kubernetes-secrets-cloud-sync
              envFrom:
                - secretRef:
                    name: kubernetes-secrets-cloud-sync-config
              env:
                - name: JOB_MODE
                  value: "true"
                - name: DELETE_ORPHANED_SECRETS
                  value: "true"
              resources:
                limits:
                  memory: 500Mi
                  cpu: 200m
                requests:
                  memory: 50Mi
                  cpu: 50m
              imagePullPolicy: Always
          restartPolicy: Never
```

> **Note:** Environment variables from `envFrom.secretRef` can hold cloud credentials (e.g. `AWS_SECRETSMANAGER_ACCESS_KEY_ID`, `ALIBABA_KMS_ACCESS_KEY_SECRET`) and other sensitive configuration. For AWS, IRSA (IAM Roles for Service Accounts) is the recommended alternative.

#### `kustomization.yaml` (optional)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - rbac.yaml
  - cronjob.yaml
```

### Deploy

```bash
kubectl apply -k .
```

### Annotate Namespaces to Sync Secrets

Once the service is running, annotate any namespace to start syncing secrets into it:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-application
  annotations:
    secrets.cloudsync.devopsplaybook.io/aws-secretsmanager: "prod/my-app/database,prod/my-app/api-keys"
    secrets.cloudsync.devopsplaybook.io/restic: "my-common-secrets"
```

### Running as a Long-Lived Service

If you prefer a Deployment (e.g. to expose the HTTP API for manual sync triggers) instead of a CronJob:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubernetes-secrets-cloud-sync
  namespace: kubernetes-secrets-cloud-sync
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kubernetes-secrets-cloud-sync
  template:
    metadata:
      labels:
        app: kubernetes-secrets-cloud-sync
    spec:
      serviceAccountName: kubernetes-secrets-cloud-sync
      containers:
        - image: your-registry/kubernetes-secrets-cloud-sync:latest
          name: kubernetes-secrets-cloud-sync
          envFrom:
            - secretRef:
                name: kubernetes-secrets-cloud-sync-config
          env:
            - name: SYNC_CRON_SCHEDULE
              value: "*/5 * * * *"
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /api/status
              port: 8080
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 8080
            periodSeconds: 20
          resources:
            limits:
              memory: 500Mi
              cpu: 200m
            requests:
              memory: 50Mi
              cpu: 50m
```

### Container image and security hardening

The `Dockerfile` builds in three stages: a builder compiles TypeScript, a
dedicated stage installs production dependencies only (`npm ci --omit=dev`),
and the runtime image copies those `node_modules` plus `dist`. The image
contains no devDependencies (no Jest/TypeScript/SWC) and runs as the unprivileged
`node` user (uid/gid 1000), with `/opt/app` owned by it. The `restic` CLI is
installed in the runtime image.

The image defines a Docker `HEALTHCHECK` that calls `GET /api/status` on
`127.0.0.1:${API_PORT:-8080}`, so an unreachable or `503 degraded` API reports
the container as unhealthy. It is skipped when `JOB_MODE` is `true`/`1` (job
mode does not listen and exits). Kubernetes ignores image healthchecks; the
probes documented above remain the Kubernetes health gate. If the API port is
changed via `config.json` instead of the `API_PORT` environment variable, the
healthcheck keeps probing the default port: set `API_PORT` as an environment
variable or override the healthcheck.

Recommended pod and container `securityContext` (documentation only — adapt it
to your own manifests):

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  containers:
    - name: kubernetes-secrets-cloud-sync
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: tmp
          mountPath: /tmp
      env:
        # restic needs a writable cache when the root filesystem is read-only.
        - name: RESTIC_CACHE_DIR
          value: /tmp/restic-cache
  volumes:
    - name: tmp
      emptyDir: {}
```

With `readOnlyRootFilesystem: true` the `/tmp` `emptyDir` is required: restic
writes its cache there, and the controller itself does not write to disk. The
mounted `config.json` must be readable by uid/gid 1000 (mode `644` is fine).

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
