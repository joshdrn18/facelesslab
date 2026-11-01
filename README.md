# FacelessLab

AI-assisted faceless video creation platform. FacelessLab turns a topic or idea into a short-form video; it is a separate product from ClipFactory, which works with existing uploaded footage.

## Stack
- Cloudflare Pages: frontend (static files in `public/`)
- Cloudflare Workers: API (`src/index.js`)
- Cloudflare D1: application data (`migrations/`)
- Cloudflare R2: generated media assets
- Background rendering: separate job runner/queue integration (planned)

## Local development
Install Wrangler, then run the API:

```bash
npm install
npm run dev:api
```

The API currently exposes:
- `GET /health` — service health check
- `GET /` — API information

## Cloudflare setup
1. Create a D1 database named `facelesslab-db`.
2. Create an R2 bucket named `facelesslab-media`.
3. Put the D1 database ID in `wrangler.toml`.
4. Deploy the Worker with `npm run deploy:api`.
5. Create a Pages project connected to this repository. Set the build output directory to `public`; no build command is required.

Do not put provider API keys in frontend code. Add secrets to the Worker with `wrangler secret put SECRET_NAME`.

## Product direction
MVP flow: topic → script → voiceover → visuals → subtitles → rendered 9:16 video → download.
