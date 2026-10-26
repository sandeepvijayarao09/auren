import type { Namespace, ToolContext, ToolSpec } from "./types.ts";

export interface ResolvedTool {
  ns: Namespace;
  tool: ToolSpec;
}

/**
 * Apps and devices as Muse tool namespaces. The inventory is rebuilt on every
 * turn, so the model only sees devices that are online and apps that are connected.
 */
export class ToolRegistry {
  #namespaces: Namespace[] = [];

  add(...namespaces: Namespace[]): this {
    this.#namespaces.push(...namespaces);
    return this;
  }

  toResponsesTools(ctx: ToolContext): unknown[] {
    const live = this.#namespaces.filter((ns) => ns.available?.(ctx) ?? true);
    const tools: unknown[] = live.map((ns) => ({
      type: "namespace",
      name: ns.name,
      description: typeof ns.description === "function" ? ns.description(ctx) : ns.description,
      tools: ns.tools
        .filter((t) => !t.hidden)
        .map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          ...(t.deferred ? { defer_loading: true } : {}),
        })),
    }));
    const anyDeferred = live.some((ns) => ns.tools.some((t) => t.deferred && !t.hidden));
    if (anyDeferred) tools.push({ type: "tool_search" });
    return tools;
  }

  /** Resolve a model function call. Accepts `namespace` + `name`, "ns.name", or a unique bare name. */
  resolve(name: string, namespace?: string | null): ResolvedTool | undefined {
    let ns = namespace ?? undefined;
    let fn = name;
    const dotted = name.match(/^([a-z0-9_-]+)[.:](.+)$/i);
    if (!ns && dotted) [, ns, fn] = dotted;
    const matches: ResolvedTool[] = [];
    for (const n of this.#namespaces) {
      if (ns && n.name !== ns) continue;
      const tool = n.tools.find((t) => t.name === fn);
      if (tool) matches.push({ ns: n, tool });
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
}
