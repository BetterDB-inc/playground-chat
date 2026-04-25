import Valkey from "iovalkey";

declare global {
  // eslint-disable-next-line no-var
  var _valkey: Valkey | undefined;
}

function createClient(): Valkey {
  const url = process.env.VALKEY_URL ?? "redis://localhost:6399";
  return new Valkey(url);
}

// Singleton: reuse across hot-reloads in dev
export const valkey: Valkey =
  global._valkey ?? (global._valkey = createClient());
