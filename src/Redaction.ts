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

function replaceLiteral(
  text: string,
  literal: string | undefined,
  replacement: string,
): string {
  if (!literal) {
    return text;
  }
  return text.split(literal).join(replacement);
}

/**
 * Flags whose name suggests their value is a credential. Matched
 * case-insensitively anywhere in the flag name, so `--sftp.password`,
 * `--sftp.key-file` and `--auth-header` are all covered.
 */
const SENSITIVE_OPTION_NAME = /password|passwd|secret|token|key|credential|auth/i;
const OPTION_WITH_VALUE_REGEX =
  /(--[A-Za-z0-9][A-Za-z0-9._-]*)(\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|\S+)/g;

/**
 * Mask the value of CLI flags whose name looks sensitive, in both the
 * `--flag=value` and `--flag value` forms. Values may be single-quoted,
 * double-quoted or unquoted (unquoted values stop at whitespace). Non-sensitive
 * flags are left readable for diagnostics.
 */
export function maskSensitiveOptionValues(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(
    OPTION_WITH_VALUE_REGEX,
    (match, flag: string, separator: string) => {
      if (!SENSITIVE_OPTION_NAME.test(flag)) {
        return match;
      }
      return `${flag}${separator.includes("=") ? "=" : " "}***`;
    },
  );
}

/**
 * Remove restic credentials from arbitrary text (stderr, error messages):
 * replaces the literal repository, password and RESTIC_OPTIONS values, masks
 * the value of any sensitive-looking option flag, then masks any remaining URL
 * userinfo.
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
  return maskUrlUserinfo(maskSensitiveOptionValues(sanitized));
}
