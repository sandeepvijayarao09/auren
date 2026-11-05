# Meta capabilities in Auren

Each row is one Meta model or Muse feature: what Auren uses it for, where it lives in the code, and its status. Video timestamps are added when the demo is cut.

| Meta capability | Used for | Code | Status |
|---|---|---|---|
| **Muse Wonder** (`muse-wonder-1.0`), Responses API | Planner and executor: one command → many app actions | [`core/src/agent/loop.ts`](core/src/agent/loop.ts) | ✅ loop built, live run pending |
| **Parallel tool calls** (`parallel_tool_calls: true`) | Calendar, Slack and Gmail run in the same turn | [`core/src/agent/loop.ts`](core/src/agent/loop.ts) | ✅ |
| **Tool namespaces + `tool_search`** (deferred loading) | **Devices as tools:** the inventory is rebuilt each turn from the surfaces online and the apps connected | [`core/src/tools/registry.ts`](core/src/tools/registry.ts), [`core/src/tools/surfaces.ts`](core/src/tools/surfaces.ts) | ✅ hosted mode; client-executed mode next |
| **Muse Spark 1.3** (`muse-spark-1.3`) | **Muse decisions:** for each command, decides the apps, risk (read/write/send), reply device and whether to look first (2.5 s, rules as fallback; advisory, logged as a `decision` event). Also the fast spoken ack, and reads frames from the glasses and phone | [`core/src/router/router.ts`](core/src/router/router.ts), [`core/src/agent/loop.ts`](core/src/agent/loop.ts) (`fastAck`) | ✅ decisions · ✅ ack · ✅ vision live: read a real poster photo in 2.5 s ("DEMO NIGHT", 18:00, "Room 214, West Village H") ([`vision/models.ts`](core/src/vision/models.ts)) |
| **Computer use** (`{"type":"computer"}`) | Apps with no API; the driver runs on your Mac and stops before any commit | [`driver/src/guard.ts`](driver/src/guard.ts), `core/src/computer/` | ✅ runner, driver and commit guard · 🧪 the tool's shape until the first live call |
| **Muse Voice Transcribe** (realtime WebSocket, keyword biasing) | Ears on every surface, proxied through Core. Keyword biasing boosts the wake phrase "Hey Muse" and your contacts' and channels' names. | [`core/src/voice/`](core/src/voice/), [`AurenKit/Voice.swift`](apps/apple/AurenKit/Sources/AurenKit/Voice.swift) | ✅ gateway, iPhone hold-to-talk and the watch's clips ([`voice/clip.ts`](core/src/voice/clip.ts)) · live run pending the key |
| **SAM 3.1** (point prompt) | Grounds "this" in the glasses view: mask → crop → receipt outline | [`core/src/vision/models.ts`](core/src/vision/models.ts) | ✅ live: `<0f>0<\|point;x;y;w;h\|>` (frame header, object id, point with the frame size) returned the poster's box in 0.86 s on a real photo |
| **Muse Spark Open** (Baseten, `meta-models/muse-spark-open-1026`) | Auren Memory: recall and the day's recap over receipts | [`core/src/memory/`](core/src/memory/) | ✅ built, local fallback when Baseten is off · live run pending `BASETEN_API_KEY` |
| **Muse Glimmer** (LoRA fine-tune on Modal) | Future work: a smaller distilled decision model, when training credits exist | [`router/`](router/), [`core/src/router/`](core/src/router/) | ⏳ not trained: no training credits; code ready in `router/` |
| **Meta Wearables Device Access Toolkit** | Ray-Ban Meta glasses as a surface: camera frames on request, mic and speakers | [`apps/apple/`](apps/apple/) | ⏳ not available here: the glasses camera is a stub, and the iPhone's camera stands in |
| **Muse Code** | Used for part of the build | — | noted per commit |
