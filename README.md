# 美听 MěiTīng

> *měi* (美) — beautiful · *tīng* (听) — to listen

A fully static Chinese listening practice app for learners at all HSK levels.

## Features

- 🎧 **Listening-first** — every exercise starts with audio, not text
- 📊 **HSK 1–9** — covers New HSK vocabulary across all levels
- ✅ **Multiple choice** or ⌨️ **type the characters** — your choice per session
- 🔥 **Streaks** — daily practice tracking to build a habit
- 🗣️ **Browser TTS** — uses Web Speech API (no server required)
- ⚡ **AWS Polly samples** — reference-quality neural Mandarin audio for comparison
- 📦 **Fully static** — deployed on GitHub Pages, zero backend

## Local Development

```bash
npm install
npm run dev
```

Then open [http://localhost:5173/meiting/](http://localhost:5173/meiting/).

## Generating Content

> Scripts coming soon in `scripts/`.

Content lives in `src/data/` as JSON. Future scripts will parse HSK word lists and generate audio via AWS Polly.

## Deployment

GitHub Actions auto-deploys to GitHub Pages on every push to `main`.

The workflow:
1. Runs `npm ci` + `npm run build`
2. Uploads the `dist/` directory as a Pages artifact
3. Deploys via `actions/deploy-pages`

Live site: [https://prestomation.github.io/meiting/](https://prestomation.github.io/meiting/)

## Tech Stack

- [Vite](https://vitejs.dev/) + [React](https://react.dev/) + TypeScript
- [React Router](https://reactrouter.com/) (hash-free routing with `basename`)
- Web Speech API for browser TTS
- AWS Polly for pre-generated reference audio
- GitHub Actions + GitHub Pages for CI/CD
