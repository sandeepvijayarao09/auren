# Router labelling rubric

Muse Wonder labels every training command with this rubric, word for word, so the labels stay consistent. The output must pass `auren_router.schema.parse`.

**Input:** the command, plus the devices online, which one is active, and which one the person spoke into.

**Output:** one JSON object, with no other text.

| Field | Rule |
|---|---|
| `apps` | Every namespace the command needs, in the order it will use them. Choose from: `calendar`, `slack`, `gmail`, `browser`, `glasses`, `memory`, `receipts`. Use `browser` only when no listed app can do it. Use `glasses` when the command points at something in view ("this", "that poster"). |
| `risk_tier` | The highest tier of any step. `read` looks things up. `write` changes something you can undo (move an event, create a draft). `send` reaches another person or spends money (post, invite, email, book, pay). |
| `reply_surface` | The device that should speak or show the answer. Default to the one spoken into. If that device has no voice out, pick the active voice device. If the answer is long or visual, pick the phone. |
| `needs_vision` | True only if the command can't be done without a camera frame. |

## Examples
| Command | Context | Label |
|---|---|---|
| "I'm running 15 late. Tell office hours, push my 3 PM, and draft a reply to Prof. Lee." | spoken into the watch; phone and Mac online | `{"apps":["slack","calendar","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}` |
| "Add this, and invite Priya." | spoken into the glasses; watch online | `{"apps":["glasses","calendar"],"risk_tier":"send","reply_surface":"glasses","needs_vision":true}` |
| "What did I get done today?" | typed on the Mac | `{"apps":["memory"],"risk_tier":"read","reply_surface":"web","needs_vision":false}` |
| "Undo the calendar move." | typed on the Mac | `{"apps":["receipts"],"risk_tier":"write","reply_surface":"web","needs_vision":false}` |
| "Find a table for two near there at 8 and hold it." | spoken into the phone; Mac online | `{"apps":["browser"],"risk_tier":"send","reply_surface":"phone","needs_vision":false}` |
