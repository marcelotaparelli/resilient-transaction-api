import { createHash, timingSafeEqual } from "node:crypto";

export type AuthenticatedService = {
  id: string;
};

export type ServiceCredentialConfig = {
  serviceId: string;
  apiKeySha256: string;
};

export interface ServiceAuthenticator {
  authenticate(apiKey: string): Promise<AuthenticatedService | null>;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export class Sha256ServiceAuthenticator implements ServiceAuthenticator {
  private readonly credentials: {
    serviceId: string;
    digest: Buffer;
  }[];

  constructor(credentials: ServiceCredentialConfig[]) {
    if (credentials.length === 0) {
      throw new Error("At least one service credential is required");
    }

    const serviceIds = new Set<string>();
    const hashes = new Set<string>();
    this.credentials = credentials.map((credential) => {
      const hash = credential.apiKeySha256.toLowerCase();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(credential.serviceId) ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        serviceIds.has(credential.serviceId) ||
        hashes.has(hash)
      ) {
        throw new Error("Service credential configuration is invalid");
      }
      serviceIds.add(credential.serviceId);
      hashes.add(hash);
      return {
        serviceId: credential.serviceId,
        digest: Buffer.from(hash, "hex"),
      };
    });
  }

  async authenticate(apiKey: string): Promise<AuthenticatedService | null> {
    const candidate = Buffer.from(hashApiKey(apiKey), "hex");
    let authenticated: AuthenticatedService | null = null;

    for (const credential of this.credentials) {
      if (timingSafeEqual(candidate, credential.digest)) {
        authenticated = { id: credential.serviceId };
      }
    }

    return authenticated;
  }
}
