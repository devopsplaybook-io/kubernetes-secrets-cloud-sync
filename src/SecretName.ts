import { createHash } from "crypto";

/** Fixed label/annotation domain used by this controller. */
export const CLOUDSYNC_DOMAIN = "cloudsync.devopsplaybook.io";
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY_VALUE = "kubernetes-secrets-cloud-sync";
export const SOURCE_NAME_ANNOTATION = `${CLOUDSYNC_DOMAIN}/source-name`;
export const INSTANCE_LABEL = `${CLOUDSYNC_DOMAIN}/instance`;
export const ADOPT_ANNOTATION = `${CLOUDSYNC_DOMAIN}/adopt`;
export const SECRET_NAME_LABEL = `${CLOUDSYNC_DOMAIN}/secret-name`;

export const MAX_SECRET_NAME_LENGTH = 253;
export const MAX_LABEL_VALUE_LENGTH = 63;

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Deterministically map a cloud secret identifier to a valid Kubernetes
 * Secret name (DNS-1123 subdomain, <= 253 chars).
 *
 * Already-valid names are returned unchanged (after prefixing), so existing
 * Secrets are not renamed by the normalization.
 */
export function normalizeSecretName(
  sourceName: string,
  prefix = "",
): string {
  const raw = `${prefix}${sourceName}`.toLowerCase();

  const name = raw
    .split(".")
    .map((part) =>
      part
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((part) => part.length > 0)
    .join(".");

  if (!name) {
    return `secret-${sha256Short(raw)}`;
  }

  if (name.length > MAX_SECRET_NAME_LENGTH) {
    const hash = sha256Short(raw);
    const base = name
      .slice(0, MAX_SECRET_NAME_LENGTH - hash.length - 1)
      .replace(/[^a-z0-9]+$/, "");
    return `${base || "secret"}-${hash}`;
  }

  return name;
}

/** Whether a value is a valid Kubernetes label value (<= 63 chars). */
export function isValidLabelValue(value: string): boolean {
  if (value.length < 1 || value.length > MAX_LABEL_VALUE_LENGTH) {
    return false;
  }
  return /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value);
}

/** Short, stable identifier of this controller instance (annotation prefix). */
export function instanceIdForPrefix(annotationPrefix: string): string {
  return sha256Short(annotationPrefix);
}
