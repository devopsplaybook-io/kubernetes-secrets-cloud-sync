/** Options describing the values that must never reach the logs. */
export interface ResticSanitizeOptions {
  repository?: string;
  password?: string;
  options?: string;
}

/**
 * Mask the userinfo part of URLs and restic backend locations:
 * `scheme://user:pass@host` becomes `scheme://***@host` and
 * `sftp:user@host:/path` becomes `sftp:***@host:/path`.
 * Credential-free values are returned unchanged.
 */
export function maskUrlUserinfo(value: string): string {
  if (!value) {
    return value;
  }
  return value
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g, "$1***@")
    .replace(/\b(sftp|async):([^/@\s]+)@/g, "$1:***@");
}

function replaceLiteral(text: string, literal: string, replacement: string): string {
  if (!literal) {
    return text;
  }
  return text.split(literal).join(replacement);
}

/**
 * Remove restic credentials from arbitrary text (stderr, error messages):
 * replaces the literal repository, password and RESTIC_OPTIONS values and
 * masks any remaining URL userinfo.
 */
export function sanitizeResticOutput(
  text: string,
  { repository, password, options }: ResticSanitizeOptions,
): string {
  if (!text) {
    return text;
  }
  let sanitized = replaceLiteral(
    text,
    repository,
    maskUrlUserinfo(repository ?? ""),
  );
  sanitized = replaceLiteral(sanitized, password, "***");
  sanitized = replaceLiteral(sanitized, options, "***");
  return maskUrlUserinfo(sanitized);
}
