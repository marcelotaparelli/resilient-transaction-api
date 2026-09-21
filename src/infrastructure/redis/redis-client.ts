export interface RedisCommandClient {
  readonly connected: boolean;
  connect(): Promise<void>;
  send(command: string, arguments_: string[]): Promise<unknown>;
  close(): void;
}

export type RedisFailureReporter = (operation: string) => void;

type RedisClientOptions = {
  connectionTimeout: number;
  autoReconnect: boolean;
  maxRetries: number;
  enableOfflineQueue: boolean;
  enableAutoPipelining: boolean;
};

type RedisClientConstructor = new (
  url: string,
  options: RedisClientOptions,
) => RedisCommandClient;

export function createBunRedisClient(
  url: string,
  commandTimeoutMs: number,
): RedisCommandClient {
  const RedisClient = (
    Bun as unknown as { RedisClient: RedisClientConstructor }
  ).RedisClient;

  return new RedisClient(url, {
    connectionTimeout: commandTimeoutMs,
    autoReconnect: true,
    maxRetries: 1,
    enableOfflineQueue: false,
    enableAutoPipelining: true,
  });
}

export class RedisOperationTimeoutError extends Error {
  constructor() {
    super("Redis operation timed out");
    this.name = "RedisOperationTimeoutError";
  }
}

export class RedisCommandExecutor {
  private connectionAttempt: Promise<void> | null = null;

  constructor(
    readonly client: RedisCommandClient,
    private readonly timeoutMs: number,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Redis command timeout must be a positive safe integer");
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new RedisOperationTimeoutError()),
        this.timeoutMs,
      );
    });

    try {
      const connectedOperation = async (): Promise<T> => {
        if (!this.client.connected) {
          if (this.connectionAttempt === null) {
            this.connectionAttempt = this.client.connect().finally(() => {
              this.connectionAttempt = null;
            });
          }
          await this.connectionAttempt;
        }
        return operation();
      };
      return await Promise.race([connectedOperation(), timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
