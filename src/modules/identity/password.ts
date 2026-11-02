import { hash, verify } from '@node-rs/argon2';

// Production-strength Argon2id parameters (OWASP-recommended floor).
const ARGON2_PARAMS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

// A real hash of a fixed non-secret string, used so unknown-account logins
// still perform one Argon2 verification — reduces user-enumeration timing
// differences. Computed lazily once per process.
let dummyHash: string | undefined;

async function getDummyHash(): Promise<string> {
  dummyHash ??= await hash('not-a-real-password', ARGON2_PARAMS);
  return dummyHash;
}

export const passwordService = {
  hash(plain: string): Promise<string> {
    return hash(plain, ARGON2_PARAMS);
  },

  /** Constant-shape verification; safe against user-enumeration timing. */
  async verify(hashOrNull: string | null | undefined, plain: string): Promise<boolean> {
    const target = hashOrNull && hashOrNull.length > 0 ? hashOrNull : await getDummyHash();
    try {
      return await verify(target, plain);
    } catch {
      return false;
    }
  },
};
