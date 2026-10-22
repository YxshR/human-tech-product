# ADR-0012: Web application architecture

Status: accepted

## Decision
- **Server-first.** Pages are React Server Components that call the API on the server (`lib/api.ts`). The browser never holds the access token (httpOnly cookie) and never talks to the API.
- **One mutation path.** Forms post to a single server action (`submit`) that turns `type:path` field names into a JSON body (`lib/form-body.ts`), calls the API, and redirects back with `?ok=` or `?error=`. Because the API validates every body with strict Zod schemas, the UI carries no second copy of the rules; errors from the API are shown as-is.
- **The UI hides, the API enforces.** Navigation and buttons are gated on `/me/permissions` for convenience only. A missing permission or out-of-scope record still answers 403/404 from the API, which the pages render as a polite empty state.
- **Files.** Uploads go browser → web server → API (checked, hashed, stored). Downloads go through `/dl/[kind]/[id]`: the web server asks the API for a 60-second signed link and streams the bytes with the user's token, so links are never exposed or shareable.
- **Sessions.** PKCE sign-in; the refresh token lives in a path-scoped cookie (`/auth`). On a 401 the page redirects to `/auth/refresh`, which exchanges the token once (a 20-second guard cookie prevents loops) and returns to the page.
- **Safety nets.** Redirect and API-call targets are allow-listed (`safePath`, `safeApiPath`); `__proto__`/`constructor`/`prototype` keys are refused when building bodies; CSP forbids framing and external scripts.

## Consequences
New screens are mostly declarative (a table plus a form). The cost is full-page navigations after each action, which is acceptable for back-office work and keeps the app usable without client-side state.
