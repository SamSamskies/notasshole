# Asshole Detector

A satire app inspired by *Not Hotdog*: paste a Nostr identity, fetch recent public notes, and get a ridiculous **ASSHOLE** / **NOT ASSHOLE** verdict from AI.

Entertainment only. Not a personality assessment.

## How it works

1. Enter an `npub`, `nprofile`, NIP-05 address, or pubkey.
2. The browser queries public Nostr relays for recent kind 1 notes and kind 0 profile metadata.
3. Notes are deduped, filtered, and sent through the [Inference Provider API](https://github.com/SamSamskies/inference-provider-api) (`window.inference`) when an IPA extension is available.
4. If IPA is missing, you can opt in to a hosted [Gemini Developer API](https://ai.google.dev/) fallback via a Vercel `/api/judge` function (explicit consent required; notes go to our backend, then Google).
5. The model returns a JSON verdict; the UI shows the joke plus a **Judged by** credit.

Private keys (`nsec`) are rejected on input. Any `nsec1…` text found in notes is redacted before inference.

## Requirements

- Node.js + npm
- A secure context (`https://` or `localhost`)
- [Inference Bridge](https://chromewebstore.google.com/detail/ekjldffogogadhfhgkibgkfdhhikfamd) (or another IPA extension), **or** the hosted Gemini fallback configured below

## Develop (frontend only)

```bash
npm ci
npm run dev
```

Vite alone does not serve `/api`. The hosted Gemini path will look unavailable until you run the API locally or deploy.

## Develop with Gemini fallback (local API)

1. Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY` (AI Studio key on a Free Tier project with no billing attached).
2. Never prefix the key with `VITE_` (that would ship it to the browser).
3. Run the Vite app and the serverless function together:

```bash
npm ci
npx vercel dev
```

`vercel dev` loads `.env.local`, serves `/api/judge`, and proxies the Vite app. No production deploy is required to try the fallback.

Optional env (see `.env.example`): `GEMINI_MODEL`, `GEMINI_FALLBACK_ENABLED`, generous daily caps.

## Build

```bash
npm ci
npm run build
```

Static output lands in `dist/`. For Vercel: build command `npm run build`, output directory `dist`. Set `GEMINI_API_KEY` in the Vercel project env.

## Hosted Gemini notes

- IPA stays preferred. Hosted Gemini only runs after IPA is unavailable and the user agrees.
- Consent is stored in `sessionStorage` for the tab session.

## Stack

- TypeScript + Vite
- Vercel Edge Function (`api/judge.ts`) for optional Gemini fallback
- [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools)
- [`ipa-tools`](https://www.npmjs.com/package/ipa-tools) (Inference Provider API types + `createInference` fallbacks)

Dependencies are pinned to exact versions in `package.json`. Prefer `npm ci` so installs follow `package-lock.json`.

## License

[MIT](./LICENSE)
