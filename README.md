# kubernetes-secrets-cloud-sync

A Kubernetes controller that synchronizes secrets from cloud providers into Kubernetes namespaces based on annotations.

## How It Works

1. The service runs inside a Kubernetes cluster and periodically scans all namespaces
2. It looks for annotations on namespaces that specify which cloud secrets to sync
3. It fetches the specified secrets from cloud providers (currently Alibaba KMS)
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
    secrets.cloudsync.devopsplaybook.io/alibaba-kms: "feedwatcher,otel-common"
    secrets.cloudsync.devopsplaybook.io/aws-secretsmanager: "prod/my-app/db,prod/my-app/api"
```

This will sync the `feedwatcher` and `otel-common` secrets from Alibaba KMS and the `prod/my-app/db` and `prod/my-app/api` secrets from AWS Secrets Manager into the `my-app` namespace.

### Created Secrets

For a KMS secret named `feedwatcher` containing:

```json
{
  "LLM_MODEL": "gpt-4",
  "LLM_API_KEY": "sk-...",
  "LLM_API_URL": "https://api.openai.com/v1"
}
```

A Kubernetes Secret named `cloudsync-feedwatcher` is created with each JSON key as a separate data entry.

## Supported Cloud Providers

| Provider            | Annotation Suffix    | Status    |
| ------------------- | -------------------- | --------- |
| Alibaba KMS         | `alibaba-kms`        | Supported |
| AWS Secrets Manager | `aws-secretsmanager` | Supported |
| Restic              | `restic`             | Supported |

The architecture is designed to be extensible. Additional providers can be added by implementing the `SecretSource` interface.

### Restic Provider

The restic provider restores the **latest snapshot** of the configured restic repository for every secret fetch, reads the `<secret-name>.json` file from the snapshot (optionally under `RESTIC_PATH`), and cleans up the temporary directory afterward. Each file must contain a flat JSON object whose keys/values become the Kubernetes Secret entries.

Example file `feedwatcher.json` inside the restic snapshot:

```json
{
  "LLM_MODEL": "gpt-4",
  "LLM_API_KEY": "sk-..."
}
```

With annotation `secrets.cloudsync.devopsplaybook.io/restic: "feedwatcher"`, a Kubernetes Secret named `cloudsync-feedwatcher` is created.

The `restic` CLI must be available on the container `PATH` (included in the provided Docker image). Backend-specific environment variables (e.g. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` for S3-backed repos) should be provided via the pod environment and will be forwarded to the `restic` process.

## Configuration

Configuration can be set via `config.json` or environment variables:

| Key                                    | Default                               | Description                                  |
| -------------------------------------- | ------------------------------------- | -------------------------------------------- |
| `SYNC_CRON_SCHEDULE`                   | `*/5 * * * *`                         | Cron schedule for periodic sync              |
| `JOB_MODE`                             | `false`                               | Run sync once on startup and exit            |
| `ANNOTATION_PREFIX`                    | `secrets.cloudsync.devopsplaybook.io` | Annotation key prefix                        |
| `SECRET_NAME_PREFIX`                   | `cloudsync-`                          | Prefix for created Kubernetes secret names   |
| `DELETE_ORPHANED_SECRETS`              | `false`                               | Delete managed secrets no longer annotated   |
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
| `LOG_LEVEL`                            | `info`                                | Log level                                    |
| `API_PORT`                             | `8080`                                | HTTP API port                                |

## API Endpoints

| Method | Path          | Description               |
| ------ | ------------- | ------------------------- |
| GET    | `/api/status` | Health check              |
| POST   | `/api/sync`   | Trigger an immediate sync |

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
