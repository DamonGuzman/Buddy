interface MacSignOptions {
  identity?: string;
  [key: string]: unknown;
}

export function resolveMacSigningIdentity(
  options: MacSignOptions,
  env?: NodeJS.ProcessEnv,
): string | null;

export default function signMacApp(options: MacSignOptions): Promise<void>;
