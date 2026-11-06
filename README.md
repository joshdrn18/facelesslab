# FacelessLab

AI-assisted faceless video creation platform. FacelessLab turns a topic or idea into a short-form video; it is a separate product from ClipFactory, which works with existing uploaded footage.

## Stack
- Cloudflare Pages: frontend (static files in `public/`)
- Cloudflare Workers: API (`src/index.js`)
- Cloudflare D1: application data (`migrations/`)
- Cloudflare R2: generated media assets
- Cloudflare Queues: asynchronous script and voice-over jobs with retry handling and a dead-letter queue
- Browser FFmpeg: local MP4 rendering (cloud/background video rendering remains a later phase)

## Local development
Install Wrangler, then run the API:

```bash
npm install
npm run dev:api
```

The API currently exposes:
- `GET /health` — checks API, D1, R2 and the queue binding
- `GET /` — API information
- `POST /api/projects/:id/generate-script` — enqueue script generation
- `GET /api/projects/:id/script` — retrieve script and background job status

## Cloudflare setup
1. Create a D1 database named `facelesslab-db`.
2. Create an R2 bucket named `facelesslab-media`.
3. Put the D1 database ID in `wrangler.toml`.
4. Create the `facelesslab-jobs` and `facelesslab-jobs-dlq` queues, then configure the `JOBS` producer binding and queue consumer as shown in `wrangler.toml`.
5. Deploy the Worker with `npm run deploy:api`.
6. Create a Pages project connected to this repository. Set the build output directory to `public`; no build command is required.

Do not put provider API keys in frontend code. Add secrets to the Worker with `wrangler secret put SECRET_NAME`.

## Product direction
MVP flow: topic → script → voiceover → visuals → subtitles → rendered 9:16 video → download.
