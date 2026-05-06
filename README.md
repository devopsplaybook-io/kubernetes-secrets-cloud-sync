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
```

This will sync the `feedwatcher` and `otel-common` secrets from Alibaba KMS into the `my-app` namespace.

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

| Provider    | Annotation Suffix | Status    |
| ----------- | ----------------- | --------- |
| Alibaba KMS | `alibaba-kms`     | Supported |

The architecture is designed to be extensible. Additional providers can be added by implementing the `SecretSource` interface.

## Configuration

Configuration can be set via `config.json` or environment variables:

| Key                             | Default                               | Description                                |
| ------------------------------- | ------------------------------------- | ------------------------------------------ |
| `SYNC_CRON_SCHEDULE`            | `*/5 * * * *`                         | Cron schedule for periodic sync            |
| `ANNOTATION_PREFIX`             | `secrets.cloudsync.devopsplaybook.io` | Annotation key prefix                      |
| `SECRET_NAME_PREFIX`            | `cloudsync-`                          | Prefix for created Kubernetes secret names |
| `ALIBABA_KMS_REGION`            |                                       | Alibaba Cloud region                       |
| `ALIBABA_KMS_ACCESS_KEY_ID`     |                                       | Alibaba Cloud access key ID                |
| `ALIBABA_KMS_ACCESS_KEY_SECRET` |                                       | Alibaba Cloud access key secret            |
| `LOG_LEVEL`                     | `info`                                | Log level                                  |
| `API_PORT`                      | `8080`                                | HTTP API port                              |

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
