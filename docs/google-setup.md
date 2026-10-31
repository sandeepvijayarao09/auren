# Connect Google (Calendar, Contacts, Gmail)

Auren uses one Google sign-in for Calendar today and Gmail tomorrow. It takes about 10 minutes. Use a **demo Google account**, not your university account: the demo uses fictional people only, and university accounts often block unverified apps.

## 1. Create the OAuth client
1. Open [console.cloud.google.com](https://console.cloud.google.com), signed in as the demo account, and create a project named **Auren**.
2. **APIs & Services → Library.** Enable **Google Calendar API**, **People API** and **Gmail API**.
3. **Google Auth Platform → Branding.** App name **Auren**; use the demo account for the support and contact emails.
4. **Audience.** User type **External**, publishing status **Testing**. Under **Test users**, add the demo account's address.
5. **Clients → Create client.** Application type **Desktop app**, name **Auren Core**. Copy the client ID and client secret.

A Desktop client lets Google send the browser back to `http://127.0.0.1:<port>`, so there's no redirect URI to register.

## 2. Add it to Auren
Put both values in `Auren/.env` yourself (never paste them into a chat):
```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
```
Restart Core with `make dev`. It prints `calendar: Google, not connected yet`.

## 3. Sign in
1. On the same Mac, open **http://127.0.0.1:8787/connect/google**.
2. Pick the demo account. Google warns that it hasn't verified the app; choose **Continue**, since this is your own app in testing.
3. Allow the scopes. The page says **Google is connected**, and Core now prints the account.

Try it in the console: "What's on my calendar today?", then "Move my 3 PM to 4".

## What Auren asks for, and why
| Scope | Used for | Tier |
|---|---|---|
| `calendar.events` | List, move and create events; invite people | List: read · move, create: write · invite: **send** |
| `contacts.readonly` | Find a person's email by name ("invite Priya") | read |
| `gmail.readonly` | Find the thread to reply to (Day 2) | read |
| `gmail.compose` | Create drafts (Day 2). Sending a draft is a send-tier step | write |
| `openid`, `email` | Show which account is connected | — |

Moving or creating an event never emails anyone (`sendUpdates=none`). Only `invite` notifies people, which is why it always waits for a tap.

## Good to know
- **Tokens are encrypted** (AES-256-GCM) in `auren.db`, with the key in `auren.db.key` or `AUREN_SECRET`. Delete both files to make Auren forget the account.
- **Testing mode expires sign-ins after 7 days.** A sign-in on Oct 31 lasts until about Nov 7, so connect again before the finals on Nov 9. Auren tells you when it has been signed out.
- **The time zone** comes from this Mac. Set `AUREN_TZ` (for example `America/Los_Angeles`) to override it.
