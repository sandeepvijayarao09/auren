// Devices as tools: this namespace exists only while a matching surface is online,
// and its description tells the model which devices are with the user right now.
import type { Namespace } from "./types.ts";
import { params } from "./types.ts";

export const surfacesNamespace: Namespace = {
  name: "surfaces",
  app: "Auren",
  description: (ctx) => {
    const online = ctx.surfaces.online().map((s) => `${s.kind} (${[...s.inputs, ...s.outputs].join(", ")})`);
    return `The user's devices that are online right now: ${online.join("; ") || "none"}. ` +
      "Use show_card for anything too long to say out loud.";
  },
  available: (ctx) => ctx.surfaces.online().some((s) => s.outputs.includes("screen")),
  tools: [
    {
      name: "show_card",
      description: "Show a card (title + short body) on the user's best screen.",
      parameters: params({ title: { type: "string" }, body: { type: "string" } }),
      tier: "read",
      async run({ title, body }: { title: string; body: string }, ctx) {
        return { shown_on: ctx.surfaces.showCard(title, body) };
      },
    },
  ],
};
