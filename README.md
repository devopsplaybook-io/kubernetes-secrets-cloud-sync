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
    secrets.cloudsync.devopsplaybook.io/alibaba-kms: "my-app-database,my-app-api-config"
    secrets.cloudsync.devopsplaybook.io/aws-secretsmanager: "prod/my-app/database,prod/my-app/api-keys"
    secrets.cloudsync.devopsplaybook.io/restic: "shared-certificates"
```

This will sync:

- `my-app-database` and `my-app-api-config` from **Alibaba KMS**
- `prod/my-app/database` and `prod/my-app/api-keys` from **AWS Secrets Manager**
- `shared-certificates` from **Restic**

All fetched secrets become Kubernetes Secret resources in the `my-app` namespace, each prefixed with the configured `SECRET_NAME_PREFIX` (default: `cloudsync-`).

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

## Deployment to Kubernetes

The service is designed to run inside a Kubernetes cluster as a CronJob (job mode) or as a long-running Deployment.

### Required RBAC Permissions

Because the service scans all namespaces for annotations and creates secrets in arbitrary namespaces, it needs a **ClusterRole**. Below are the minimum required permissions:

| Resource     | Verbs                                                | Reason                                                                |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `namespaces` | `get`, `list`                                        | Scan all namespaces for sync annotations                              |
| `secrets`    | `get`, `list`, `create`, `update`, `patch`, `delete` | Create/update synced secrets, list managed secrets for orphan cleanup |

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
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
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
          resources:
            limits:
              memory: 500Mi
              cpu: 200m
            requests:
              memory: 50Mi
              cpu: 50m
```

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
