import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { serve, type ServerType } from "@hono/node-server";

/** PEM paths for TLS. Both set means HTTPS and WSS on the same port; either missing means plain HTTP. */
export type TlsFiles = { cert?: string; key?: string };

export function tlsEnabled(tls: TlsFiles): boolean {
  return Boolean(tls.cert && tls.key);
}

/** Serves `fetch` over HTTPS when both PEM files are given, else over HTTP. WebSocket upgrades ride the same server. */
export function listen(
  opts: { fetch: (req: Request, ...rest: any[]) => Response | Promise<Response>; port: number; hostname: string; tls: TlsFiles },
  onListening?: (info: { port: number }) => void,
): ServerType {
  const { fetch, port, hostname, tls } = opts;
  if (!tlsEnabled(tls)) return serve({ fetch, port, hostname }, onListening);
  return serve(
    { fetch, port, hostname, createServer: createHttpsServer, serverOptions: { cert: readFileSync(tls.cert!), key: readFileSync(tls.key!) } },
    onListening,
  );
}
