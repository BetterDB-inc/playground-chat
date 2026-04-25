/**
 * Typed wrapper for raw Valkey commands. iovalkey exposes `.call()` for
 * arbitrary commands but it's typed as `unknown` - wrapping once here lets
 * the rest of the codebase call `cmd("FT.SEARCH", ...)` without scattering
 * `as unknown as { call: ... }` dances.
 */

import type Valkey from "iovalkey";

type RawClient = { call: (...args: unknown[]) => Promise<unknown> };

export function cmd<T = unknown>(
  client: Valkey,
  command: string,
  ...args: (string | number | Buffer)[]
): Promise<T> {
  return (client as unknown as RawClient).call(command, ...args) as Promise<T>;
}

/**
 * RediSearch reserves several characters in its query syntax. When a value
 * comes from user input or an LLM tool call, escape these so the value is
 * treated as a literal token rather than a query operator.
 *
 * Reference: https://valkey.io/topics/valkey-search/#querying - the
 * punctuation set matches the index's tokeniser by default.
 */
const RESERVED = /[,.<>{}[\]"':;!@#$%^&*()\-+=~/\\|?\s]/g;

export function escapeSearchValue(s: string): string {
  return s.replace(RESERVED, (m) => "\\" + m);
}

/**
 * Helper for TAG fields: TAG values are matched verbatim so escaping rules
 * differ slightly. Curly braces and the field's separator (default `,`) are
 * the main ones to handle.
 */
export function escapeTagValue(s: string): string {
  return s.replace(/[{}\\,]/g, (m) => "\\" + m);
}
