// What the sandbox can replay: the five golden paths and the planted-email case,
// straight from eval/cases and eval/scripts, so the page plays exactly what the
// eval checks. Each is a one-tap example on the page.
import { loadCases, type Case } from "../eval/run.ts";
import { loadScript, type ScriptCommand } from "../eval/scripted.ts";

export interface Example {
  id: string;
  golden: string;
  label: string;
  /** The device the command comes from. */
  where: "phone" | "watch" | "glasses";
  text: string;
}

export interface ReplayEntry extends Example {
  case: Case;
  index: number;
  command: ScriptCommand;
}

const CHIPS: Array<Omit<Example, "text" | "where"> & { case: string; index: number }> = [
  { id: "gp1", case: "gp1-watch-fan-out", index: 0, golden: "GP1", label: "Running 15 late" },
  { id: "gp2", case: "gp2-glasses-poster", index: 0, golden: "GP2", label: "Add this poster" },
  { id: "gp3", case: "gp3-approval-moves", index: 0, golden: "GP3", label: "The tap follows you" },
  { id: "gp4", case: "gp4-hold-a-table", index: 0, golden: "GP4", label: "Hold a table" },
  { id: "gp5-recap", case: "gp5-recap-then-undo", index: 0, golden: "GP5", label: "Recap my day" },
  { id: "gp5-undo", case: "gp5-recap-then-undo", index: 1, golden: "GP5", label: "Undo the move" },
  { id: "injection", case: "injection-email-asks-to-post", index: 0, golden: "Safety", label: "A planted email" },
];

const DEVICES = new Set(["phone", "watch", "glasses"]);

export function loadCatalog(): ReplayEntry[] {
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  return CHIPS.map((chip) => {
    const c = cases.get(chip.case);
    const command = loadScript(chip.case)?.commands[chip.index];
    if (!c || !command || !c.commands[chip.index]) throw new Error(`the sandbox needs eval case ${chip.case}, command ${chip.index + 1}, and its script`);
    const where = (DEVICES.has(c.surface) ? c.surface : "phone") as Example["where"];
    return { id: chip.id, golden: chip.golden, label: chip.label, where, text: c.commands[chip.index], case: c, index: chip.index, command };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The example a command is, ignoring case and punctuation. */
export function match(catalog: ReplayEntry[], text: string): ReplayEntry | undefined {
  const t = norm(text);
  return catalog.find((e) => norm(e.text) === t);
}

export const examples = (catalog: ReplayEntry[]): Example[] => catalog.map(({ id, golden, label, where, text }) => ({ id, golden, label, where, text }));
