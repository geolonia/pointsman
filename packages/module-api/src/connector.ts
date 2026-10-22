// Connectors (docs/connectors.md): the module role that brings cases in
// (webhooks, notifications, polling) and carries results out. A connector
// talks to the engine only through its public API, with its own client
// token, so every decision goes through the same authentication, policy,
// idempotency and decision log as any other client's. It never calls the
// engine's code around that.
//
// A connector runs inside the engine Worker (placement "engine", mounted
// under /connectors/<id>/) or next to it, in its own Worker or process
// ("own"). Its code is the same in both; only the engine API it is given
// differs.
//
// Node-safe, like api.ts: no runtime-specific API.

export type Placement = 'engine' | 'own';

/** What a module tells about its connector role. Data, so docs and checks can read it. */
export interface ConnectorDef {
  /** Short id: the path under /connectors/ when it runs inside the engine Worker. */
  id: string;
  /** Where it can run. */
  placements: Placement[];
  /** The settings (environment variables and bindings) it reads. */
  settings: string[];
  /**
   * The only actions it can carry out, a fixed list. A deployment can switch
   * them on, never add one.
   */
  actions: string[];
}

/** The engine's public API (openapi.yaml), as a connector reaches it. */
export interface EngineApi {
  /** The base URL the paths go after, without a trailing slash. */
  url: string;
  /** Sends a request to the engine; the connector adds its own token. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** A message from the queue, as the runtime hands it over. */
export interface ConnectorMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/**
 * What the runtime gives a connector besides its settings. Bindings such as
 * a queue are settings too: the connector lists and reads them.
 */
export interface ConnectorRuntime {
  /** The engine. Inside the engine Worker, a call in process through the same routes. */
  engine: EngineApi;
}

export interface Connector {
  /** A request to one of its paths; the URL's path is relative to where it is mounted ("/notify"). */
  fetch(request: Request): Promise<Response>;
  /** Messages from its queue (inside the engine Worker: the Worker's only queue consumer). */
  queue?(batch: { messages: readonly ConnectorMessage[] }): Promise<void>;
}

/** The entry of a module with the role "connector". */
export interface ConnectorEntry {
  name: string;
  version: string;
  connector: ConnectorDef;
  /**
   * The connector for these settings; undefined when it is switched off (none
   * of its settings is set). Throws ConfigError on settings that are missing
   * or do not fit together.
   */
  connect(env: Record<string, unknown>, runtime: ConnectorRuntime, placement: Placement): Connector | undefined;
}
