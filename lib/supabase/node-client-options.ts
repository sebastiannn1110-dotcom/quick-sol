class ServerOnlyRealtimeTransport {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly readyState = this.CLOSED;
  readonly protocol = "";
  onopen: ((this: unknown, ev: Event) => unknown) | null = null;
  onmessage: ((this: unknown, ev: MessageEvent) => unknown) | null = null;
  onclose: ((this: unknown, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  readonly url: string;

  constructor(address: string | URL) {
    this.url = String(address);
    throw new Error("Supabase Realtime is disabled for server-only clients.");
  }

  close() {
    throw new Error("Supabase Realtime is disabled for server-only clients.");
  }

  send() {
    throw new Error("Supabase Realtime is disabled for server-only clients.");
  }

  addEventListener() {
    throw new Error("Supabase Realtime is disabled for server-only clients.");
  }

  removeEventListener() {
    throw new Error("Supabase Realtime is disabled for server-only clients.");
  }

  dispatchEvent(): boolean {
    throw new Error("Supabase Realtime is disabled for server-only clients.");
  }
}

export function serverSupabaseClientOptions() {
  return {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    realtime: {
      transport: ServerOnlyRealtimeTransport
    }
  };
}
