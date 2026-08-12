# Asshole Detector

A satire app inspired by *Not Hotdog*: paste a Nostr identity, fetch recent public notes, and get a ridiculous **ASSHOLE** / **NOT ASSHOLE** verdict from AI.

Entertainment only. Not a personality assessment.

## How it works

1. Enter an `npub`, `nprofile`, NIP-05 address, or pubkey.
2. The browser queries public Nostr relays for recent kind 1 notes and kind 0 profile metadata.
3. Notes are deduped, filtered, and sent through the [Inference Provider API](https://github.com/SamSamskies/inference-provider-api) (`window.inference`).
4. Your chosen model returns a JSON verdict; the UI shows the joke plus a **Judged by** credit.

There is no app backend and no API keys in the site. Inference runs through an IPA-compatible browser extension such as [Inference Bridge](https://chromewebstore.google.com/detail/ekjldffogogadhfhgkibgkfdhhikfamd).

Private keys (`nsec`) are rejected on input. Any `nsec1…` text found in notes is redacted before inference.

## Requirements

- Node.js + npm
- A secure context (`https://` or `localhost`)
- [Inference Bridge](https://chromewebstore.google.com/detail/ekjldffogogadhfhgkibgkfdhhikfamd) (or another IPA extension)

## Develop

```bash
npm ci
npm run dev
```

## Build

```bash
npm ci
npm run build
```

Static output lands in `dist/`. For Vercel: build command `npm run build`, output directory `dist`.

## Stack

- TypeScript + Vite
- [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools)
- Inference Provider API (`window.inference`)

Dependencies are pinned to exact versions in `package.json`. Prefer `npm ci` so installs follow `package-lock.json`.

## License

[MIT](./LICENSE)
