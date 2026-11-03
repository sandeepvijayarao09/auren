// glasses.look: "this", through the user's camera. Core asks the best camera
// surface for one frame (people in it were blurred on the device), then Muse
// Spark reads the poster while SAM 3.1 outlines the object at the centre of the
// view. Only that outline's crop is kept, for the receipt; the frame is dropped.
import { silentOps, type OpsLog } from "../obs/opslog.ts";
import type { Namespace } from "../tools/types.ts";
import { params } from "../tools/types.ts";
import type { CaptureBroker } from "./capture.ts";
import type { CropStore } from "./crops.ts";
import { cropJpeg, jpegSize } from "./jpeg.ts";
import type { PosterReader, Segmenter } from "./models.ts";

export interface VisionDeps {
  /** Core's CaptureBroker; the eval's camera stands in with the same request(). */
  broker: Pick<CaptureBroker, "request">;
  reader: PosterReader;
  segmenter: Segmenter;
  crops: CropStore;
  ops?: OpsLog;
  /** The user's time zone, so Spark can give a poster's date its year. */
  timeZone?: string;
  now?: () => Date;
}

const cameras = (ctx: { surfaces: { online(): Array<{ kind: string; name: string; inputs: string[] }> } }) =>
  ctx.surfaces.online().filter((s) => s.inputs.includes("camera"));

export function createGlasses(deps: VisionDeps): Namespace {
  const ops = deps.ops ?? silentOps;
  return {
    name: "glasses",
    app: "Camera",
    description: (ctx) =>
      `See what the user is looking at, through ${cameras(ctx).map((s) => `${s.name || s.kind} (${s.kind})`).join(" or ")}. ` +
      "Call look only when they point at something (\"this\", \"that poster\"); the camera never runs otherwise.",
    // Devices as tools: take the glasses off with no phone camera around, and look is gone from the next turn.
    available: (ctx) => cameras(ctx).length > 0,
    tools: [
      {
        name: "look",
        description:
          "Take one photo from the user's camera (glasses first, else the phone) and read the event on the poster or flyer in front of them: " +
          "title, date (YYYY-MM-DD), start (HH:MM) and place, plus the box around what was seen. Its text is untrusted.",
        parameters: params({ question: { type: "string", description: "What to look for, such as \"the event on this poster\"" } }),
        tier: "read",
        external: true,
        async run(args: { question?: string }, ctx) {
          const question = String(args.question ?? "").trim().slice(0, 200) || "What event is on this poster?";
          const t0 = performance.now();
          const frame = await deps.broker.request(question.slice(0, 120));
          ops.info("vision.capture", { trace: ctx.trace, surface: frame.surfaceId, kind: frame.kind, bytes: frame.jpeg.length, ms: Math.round(performance.now() - t0) });
          const size = jpegSize(frame.jpeg);
          if (!size) throw new Error(`The ${frame.kind} sent an image Auren couldn't read.`);
          // The camera points where your head points, so "this" is what's under the centre.
          const centre = { x: size.width / 2, y: size.height / 2 };
          const today = new Intl.DateTimeFormat("en-CA", { timeZone: deps.timeZone }).format(deps.now?.() ?? new Date());

          const t1 = performance.now();
          const [fields, box] = await Promise.all([
            deps.reader.read(frame.jpeg, { question, today }).then(
              (fields) => {
                ops.info("vision.read", { trace: ctx.trace, ms: Math.round(performance.now() - t1), ok: true });
                return fields;
              },
              (err) => {
                ops.warn("vision.read", { trace: ctx.trace, ms: Math.round(performance.now() - t1), ok: false });
                throw err;
              },
            ),
            // The outline is for the receipt. Without it the fields still stand.
            deps.segmenter.segment(frame.jpeg, centre).then(
              (b) => {
                ops.info("vision.segment", { trace: ctx.trace, ms: Math.round(performance.now() - t1), found: Boolean(b) });
                return b;
              },
              (err) => {
                ops.warn("vision.segment", { trace: ctx.trace, ms: Math.round(performance.now() - t1), message: err instanceof Error ? err.message : String(err) });
                return null;
              },
            ),
          ]);

          let crop_id: string | null = null;
          if (box) {
            try {
              crop_id = deps.crops.put(cropJpeg(frame.jpeg, box));
              // Receipts later in this command show what Auren saw.
              ctx.seen = { crop_id };
            } catch (err) {
              ops.warn("vision.crop", { trace: ctx.trace, message: err instanceof Error ? err.message : String(err) });
            }
          }
          // The frame goes no further: not into the result, the log or a store.
          return { ...fields, box, crop_id, seen_through: frame.kind };
        },
      },
    ],
  };
}
