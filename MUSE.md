# Meta capabilities in Auren

Each row is one Meta model or Muse feature: what Auren uses it for, where it lives in the code, and its status. Video timestamps are added when the demo is cut.

| Meta capability | Used for | Code | Status |
|---|---|---|---|
| **Muse Wonder** (`muse-wonder-1.0`), Responses API | Planner and executor: one command → many app actions | [`core/src/agent/loop.ts`](core/src/agent/loop.ts) | ✅ loop built, live run pending |
| **Parallel tool calls** (`parallel_tool_calls: true`) | Calendar, Slack and Gmail run in the same turn | [`core/src/agent/loop.ts`](core/src/agent/loop.ts) | ✅ |
| **Tool namespaces + `tool_search`** (deferred loading) | **Devices as tools:** the inventory is rebuilt each turn from the surfaces online and the apps connected | [`core/src/tools/registry.ts`](core/src/tools/registry.ts), [`core/src/tools/surfaces.ts`](core/src/tools/surfaces.ts) | ✅ hosted mode; client-executed mode next |
| **Muse Spark 1.3** (`muse-spark-1.3`) | Fast spoken acknowledgement (minimal effort); reads frames from the glasses and phone | [`core/src/agent/loop.ts`](core/src/agent/loop.ts) (`fastAck`) | ✅ ack · ⏳ vision |
| **Computer use** (`{"type":"computer"}`) | Apps with no API; the driver runs on your Mac and stops before any commit | `driver/` | ⏳ Day 6 |
| **Muse Voice Transcribe** (realtime WebSocket, keyword biasing) | Ears on every surface, proxied through Core. Keyword biasing boosts the wake phrase "Hey Muse" and your contacts' and channels' names. | `core/src/voice/` | ⏳ Day 3 |
| **SAM 3.1** (point prompt) | Grounds "this" in the glasses view: mask → crop → receipt outline | `core/src/vision/` | ⏳ Day 5 |
| **Muse Spark Open** (Baseten, `meta-models/muse-spark-open-1026`) | Memory Hub: recall and the day's recap over receipts | `core/src/memory/` | ⏳ Day 7 |
| **Muse Glimmer** (LoRA fine-tune on Modal) | Auren Router: intent, risk tier and reply surface in one fast call | `router/` | ⏳ gated on Nov 1 |
| **Muse Code** | Used for part of the build | — | noted per commit |
