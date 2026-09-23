import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { compileSecretStore, SecretError, type BrowserSecretDefinition, type BrowserSecretOptions } from "./secret-store.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

function invalid(): never { throw new SecretError("SECRET_CONFIG_INVALID"); }

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !allowed.includes(key))) invalid();
  return object;
}

/** CLI-only JSON configuration. Environment values are read only by a scoped resolver. */
export function loadSecretConfig(path: string, environment: NodeJS.ProcessEnv = process.env): BrowserSecretOptions {
  let descriptor: number | undefined;
  try {
    // Reject FIFOs/devices without waiting for a writer. Bound the actual read
    // as well as the initial size, since a regular file can grow after fstat.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) invalid();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) invalid();
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    const input = fields(JSON.parse(encoded), ["contextId", "secrets", "allowSensitiveArtifacts"]);
    if (!Array.isArray(input.secrets) || input.secrets.length > 32) invalid();
    const secrets: BrowserSecretDefinition[] = input.secrets.map(value => {
      const item = fields(value, ["name", "version", "allowedOrigins", "allowedTopOrigins", "env"]);
      const env = item.env;
      if (typeof env !== "string" || !ENVIRONMENT_NAME.test(env)) invalid();
      // Only this closure knows the variable name; neither it nor its value is
      // copied into the browser configuration's serializable metadata.
      return {
        name: item.name as string,
        version: item.version as string,
        allowedOrigins: item.allowedOrigins as string[],
        ...(Object.hasOwn(item, "allowedTopOrigins") ? { allowedTopOrigins: item.allowedTopOrigins as string[] } : {}),
        resolve(signal: AbortSignal): string {
          if (signal.aborted) throw new SecretError("SECRET_CANCELLED");
          let resolved: unknown;
          try { resolved = Object.hasOwn(environment, env) ? environment[env] : undefined; }
          catch { throw new SecretError("SECRET_RESOLUTION_FAILED"); }
          if (typeof resolved !== "string" || resolved.length === 0 || resolved.length > 2_048) throw new SecretError("SECRET_VALUE_INVALID");
          if (signal.aborted) throw new SecretError("SECRET_CANCELLED");
          return resolved;
        },
      };
    });
    const options: BrowserSecretOptions = {
      contextId: input.contextId as string, secrets,
      ...(Object.hasOwn(input, "allowSensitiveArtifacts") ? { allowSensitiveArtifacts: input.allowSensitiveArtifacts as boolean } : {}),
    };
    // Reuse the exact SDK origin, alias, context, version and aggregate limits.
    // Compilation validates metadata only; no environment value is resolved.
    const validated = compileSecretStore(options);
    validated?.close();
    for (const secret of secrets) {
      secret.allowedOrigins = Object.freeze([...secret.allowedOrigins]);
      if (secret.allowedTopOrigins) secret.allowedTopOrigins = Object.freeze([...secret.allowedTopOrigins]);
      Object.freeze(secret);
    }
    Object.freeze(secrets);
    return Object.freeze(options);
  } catch {
    // JSON parser / filesystem errors can contain file contents or private paths.
    throw new SecretError("SECRET_CONFIG_INVALID");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); }
      catch { throw new SecretError("SECRET_CONFIG_INVALID"); }
    }
  }
}
