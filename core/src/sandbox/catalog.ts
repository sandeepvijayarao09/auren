// What the sandbox can replay: the five golden paths, the planted email, Maya's
// proactive day, a learned preference and a follow-up, straight from eval/cases
// and eval/scripts, so the page plays exactly what the eval checks. Each is a
// one-tap example on the page.
import { loadCases, type Case } from "../eval/run.ts";
import { loadScript, type ScriptCommand } from "../eval/scripted.ts";
import type { PrefKey } from "../memory/preferences.ts";
import type { SceneId } from "./scenes.ts";

export interface Example {
  id: string;
  golden: string;
  label: string;
  /** The device the command comes from. */
  where: "phone" | "watch" | "glasses";
  text: string;
  /** The world it plays in. */
  scene: SceneId;
  /** An example that has to play first (the follow-up needs its first half). */
  after?: string;
}

/**
 * A replay that depends on what Auren knows: while the visitor's preferences hold `key` = `value`
 * (at prompt confidence), the entry's own script plays; once they forget it, `otherwise` plays.
 */
export interface Prefers {
  key: PrefKey;
  value: string;
  otherwise: { case: Case; command: ScriptCommand };
}

export interface ReplayEntry extends Example {
  case: Case;
  index: number;
  command: ScriptCommand;
  prefers?: Prefers;
}

interface Chip {
  id: string;
  case: string;
  index: number;
  golden: string;
  label: string;
  scene?: SceneId;
  after?: string;
  prefers?: { key: PrefKey; value: string; otherwise: string };
}

const CHIPS: Chip[] = [
  { id: "gp1", case: "gp1-watch-fan-out", index: 0, golden: "GP1", label: "Running 15 late" },
  { id: "gp2", case: "gp2-glasses-poster", index: 0, golden: "GP2", label: "Add this poster" },
  { id: "gp3", case: "gp3-approval-moves", index: 0, golden: "GP3", label: "The tap follows you" },
  { id: "gp4", case: "gp4-hold-a-table", index: 0, golden: "GP4", label: "Hold a table" },
  { id: "gp5-recap", case: "gp5-recap-then-undo", index: 0, golden: "GP5", label: "Recap my day" },
  { id: "gp5-undo", case: "gp5-recap-then-undo", index: 1, golden: "GP5", label: "Undo the move" },
  { id: "injection", case: "injection-email-asks-to-post", index: 0, golden: "Safety", label: "A planted email" },
  { id: "followup-1", case: "multi-turn-move-it-again", index: 0, golden: "Follow-up", label: "Push office hours" },
  { id: "followup-2", case: "multi-turn-move-it-again", index: 1, golden: "Follow-up", label: "Actually, 4 instead", after: "followup-1" },
  { id: "maya-briefing", case: "persona-maya-morning-briefing", index: 0, golden: "Proactive", label: "Maya's morning briefing", scene: "maya" },
  { id: "maya-plan", case: "sandbox-maya-plan-tomorrow", index: 0, golden: "Proactive", label: "Plan tomorrow", scene: "maya" },
  {
    id: "maya-late", case: "sandbox-maya-late-to-team", index: 0, golden: "Personal", label: "Tell the team I'm late", scene: "maya",
    prefers: { key: "status_channel", value: "#design-team", otherwise: "sandbox-maya-late-no-preference" },
  },
];

const DEVICES = new Set(["phone", "watch", "glasses"]);

export function loadCatalog(): ReplayEntry[] {
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  const load = (id: string, index: number) => {
    const c = cases.get(id);
    const command = loadScript(id)?.commands[index];
    if (!c || !command || !c.commands[index]) throw new Error(`the sandbox needs eval case ${id}, command ${index + 1}, and its script`);
    return { case: c, command };
  };
  return CHIPS.map((chip) => {
    const { case: c, command } = load(chip.case, chip.index);
    const where = (DEVICES.has(c.surface) ? c.surface : "phone") as Example["where"];
    const prefers = chip.prefers && { key: chip.prefers.key, value: chip.prefers.value, otherwise: load(chip.prefers.otherwise, 0) };
    return {
      id: chip.id, golden: chip.golden, label: chip.label, where, text: c.commands[chip.index], scene: chip.scene ?? "demo",
      ...(chip.after ? { after: chip.after } : {}), case: c, index: chip.index, command, ...(prefers ? { prefers } : {}),
    };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The example a command is, ignoring case and punctuation. */
export function match(catalog: ReplayEntry[], text: string): ReplayEntry | undefined {
  const t = norm(text);
  return catalog.find((e) => norm(e.text) === t);
}

export const examples = (catalog: ReplayEntry[]): Example[] =>
  catalog.map(({ id, golden, label, where, text, scene, after }) => ({ id, golden, label, where, text, scene, ...(after ? { after } : {}) }));
