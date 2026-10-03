# GitHub Dashboard (PR Dashboard)

A small, mobile-friendly page for doing quick pull-request work on GitHub from anywhere:
pick an org and repo (with ★ favourites), list open and closed PRs, see review and CI check status, view changed files and diffs, submit a review (approve, request changes or comment), and merge.

**The token never leaves your browser.** There's no backend. The page stores your token in `localStorage` on your device and sends it only to `https://api.github.com`. The production build includes a Content-Security-Policy (`connect-src https://api.github.com`), so the browser itself blocks requests anywhere else.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173, plus a Network URL for your phone
```

The dev server listens on all interfaces (`server.host: true` in `vite.config.ts`). A phone on the same Wi-Fi can open the **Network** URL that Vite prints, e.g. `http://192.168.x.x:5173`. If the phone can't connect, allow incoming connections for Node in macOS **System Settings → Network → Firewall**.

For testing on a phone, prefer the **production preview**. It doesn't reload while code is being edited, and it loads exactly like the deployed site (CSP active):

```bash
npm run build && npm run preview   # http://<your-ip>:4173
```

`mock.html` is the original clickable design mock with sample data (open `/mock.html#demo` on the dev server).

## Deploy publicly (GitHub Pages, free)

1. Create a GitHub repository and push this folder to its `main` branch.
2. In the repo, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) builds and publishes on every push to `main`.
4. Open `https://aruncse-dev.github.io/github-dashboard/` on any device and sign in with your token.

The site contains no secrets, so the repo can be public. Each device and browser keeps its own token. Use **Forget token** (the sign-out icon) on shared devices.

Other static hosts work the same way: upload the `dist/` folder to Cloudflare Pages, Netlify or Vercel.

## Install as an app

The site is an installable web app (PWA): `public/manifest.webmanifest`, icons in `public/icons/`, and a service worker `public/sw.js`.
- **Android / desktop Chrome or Edge:** use the browser's own install prompt or menu → *Install app*.
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*.

It opens full-screen with its own icon. The service worker caches only the app's own files, so it opens instantly and even offline. It never caches GitHub API calls or the token. A new deploy is picked up on the next launch, because pages load network-first.

Installing needs **HTTPS**, so use the GitHub Pages URL. A plain `http://192.168.x.x` address on the local network can be added to the home screen on iPhone, but it won't install or cache on Android.

## Token permissions

| Token type | Needs |
|---|---|
| **Classic** (simplest) | `repo`, `read:org` |
| **Fine-grained** | Resource owner = the org. Repository access = the repos you want. Organization permissions: none. Repository permissions by feature: |

| Feature | Fine-grained permission |
|---|---|
| Anything (always on) | Metadata: Read (automatic) |
| PR list, details, files changed, labels, comments | Pull requests: Read |
| CI status from external systems (Jenkins, Vercel…) | Commit statuses: Read |
| GitHub Actions results: jobs, steps, durations | Actions: Read |
| Approve / request changes / comment | Pull requests: Read and write |
| Merge | Contents: Read and write |

Fine-grained tokens have **no "Checks" permission**, so they can't read check runs. For these tokens the app gets GitHub Actions results from the Actions API instead: one request per PR list for the cards, plus jobs and steps in PR details. Classic tokens (`repo`) read check runs directly, including their error annotations.

The smallest useful token: **Pull requests: Read**, **Commit statuses: Read** and **Actions: Read**. Make Pull requests *Read and write* to approve, and add *Contents: Read and write* only if you merge from the app.


Notes for fine-grained tokens:
- They can't list your organizations. The app works out the orgs from the repositories the token can reach, or you can type an org name in the org picker.
- Many orgs require an owner to **approve** fine-grained tokens (Organization → Settings → Personal access tokens → Pending requests). Until then the token reaches nothing in that org.
- If anything is missing, use **Check token access**. It's offered on the error box and on empty lists, tests each request the app needs, and has **Copy report** to share the result. The report never contains the token.

If your org enforces SAML SSO, authorize the token for the org (GitHub → Settings → Developer settings → Tokens → *Configure SSO*). The app shows an SSO hint when GitHub rejects a request for that reason.

## How it works

| Feature | GitHub API |
|---|---|
| PR list with review state, checks, conflicts, counts | GraphQL `search(type: ISSUE)`, 10 per page + Load more |
| Org picker | GraphQL `viewer.organizations` (cached) |
| Repo picker | 30 most recently updated repos (one request, cached), plus live GraphQL `search(type: REPOSITORY)` as you type |
| Search suggestions | Qualifiers, recent searches, authors and branches from loaded PRs, repo labels via GraphQL `repository.labels` |
| PR details (tap a card) | GraphQL `node(id)`: checks with status and duration, reviews, description, latest commits and comments. A check's summary and annotations load on tap via the `CheckRun` node. Refreshes every 15 s while checks are running. Raw CI logs aren't available in the browser |
| Files changed and diffs | REST `GET /repos/{o}/{r}/pulls/{n}/files` |
| Review | REST `POST /repos/{o}/{r}/pulls/{n}/reviews`. Hidden on your own PRs (GitHub forbids self-approval); Approve is disabled if you already approved |
| Merge | Shown only for non-draft PRs where your permission is write/maintain/admin. REST `PUT /repos/{o}/{r}/pulls/{n}/merge` (sends the head SHA, so it never merges commits you didn't see) |

**Favourites, cache and defaults.**
- Star (☆) orgs and repos in the pickers. Favourites always come first, and the pickers open on the Favourites tab.
- The org list and each org's 30 most recently updated repos are cached in `localStorage` (`gh_pr_cache_v2`). The app fetches them only the first time, or when you tap **Sync** in a picker. Typing in the repo picker searches every repo in the org on GitHub. The header ↻ button reloads PRs only.
- A single repository is always selected; there's no "all repositories" view. On load the app restores your last org and repo. If there isn't one, it picks the first favourite org and its first favourite repo, falling back to the most recently updated repo.
- **Forget token** clears the token, the cache and the last selection, but keeps favourites (`gh_pr_favs`).

The search box accepts GitHub search syntax (`author:name`, `label:bug`, `head:branch`, `base:main`, `review:approved`, `status:failure`, `created:>=2026-01-01`, `#123`). A suggestion dropdown offers these filters and their values, plus your recent searches. Use ↑/↓ and Enter, or tap.

## Project layout

```
index.html        app shell and dialogs
src/main.ts       state, rendering and event wiring
src/api.ts        token storage, plus REST and GraphQL fetch helpers
src/queries.ts    GraphQL queries, types and check-status helpers
src/ui.ts         icons, escaping, toasts, dialogs and diff rendering
src/suggest.ts    search-box autocomplete (filters, values, recent searches)
src/favorites.ts  starred orgs and repos
src/cache.ts      local cache of orgs and recent repos
public/           manifest, service worker, app icons (copied as-is into the build)
design/           source SVGs for the maskable and Apple icons
src/styles.css    GitHub-style theme (light/dark), mobile-first layout
vite.config.ts    CSP injection for builds, dev server on 0.0.0.0
```
