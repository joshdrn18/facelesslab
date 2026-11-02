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


## Voice-over providers

The voice-over endpoint supports Google Cloud Text-to-Speech and ElevenLabs. Google is the default provider and uses Indonesian Standard voices by default (id-ID-Standard-A female, id-ID-Standard-B male), which currently fall within Google's free quota of 4 million characters per month. Billing must still be enabled on the Google Cloud project; Google bills usage beyond the free quota at its published Standard voice rate. The implementation defaults to Standard voices; Google's current pricing page also lists monthly free quotas for WaveNet and Chirp 3 HD, but those voices are not exposed in this UI.

### Google Cloud setup

1. In Google Cloud Console, select/create a project and enable Cloud Text-to-Speech API. Link a billing account (required by Google even when staying within the free quota).
2. Create an API key and restrict it to Cloud Text-to-Speech API. Keep application restrictions appropriate for server-side use; do not place this key in Pages or browser code.
3. In Cloudflare, open Workers & Pages → facelesslab-api → Settings → Variables and Secrets. Add the following. For the key, you can instead run `npx wrangler secret put GOOGLE_TTS_API_KEY` from this repository and paste it only into Wrangler's hidden prompt:
   - GOOGLE_TTS_API_KEY — Secret — the restricted Google API key.
   - TTS_DEFAULT_PROVIDER — Text variable — google.
   - GOOGLE_TTS_VOICE_DEFAULT — Text variable — id-ID-Standard-A (optional).
   - GOOGLE_TTS_VOICE_FEMALE — Text variable — id-ID-Standard-A (optional).
   - GOOGLE_TTS_VOICE_MALE — Text variable — id-ID-Standard-B (optional).
4. Deploy the Worker with `npm run deploy:api` and publish the Pages site. To configure ElevenLabs separately, add its existing key with `npx wrangler secret put TTS_API_KEY`; keep `TTS_VOICE_ID` as a text variable. No secret value belongs in `wrangler.toml`, README, or frontend code. The dashboard lets each voice-over request choose Google or ElevenLabs.

### ElevenLabs premium setup

Keep the existing TTS_API_KEY Worker Secret and TTS_VOICE_ID Worker Text variable. Optional text variables remain TTS_VOICE_ID_MALE, TTS_VOICE_ID_FEMALE, and TTS_MODEL. These are only sent to ElevenLabs when that provider is selected.

The Google key is sent from the Worker to Google's REST endpoint in the x-goog-api-key header; audio is decoded and continues through the existing private R2 storage and authenticated playback/download routes. No key is exposed in the frontend. See Google's [authentication](https://cloud.google.com/text-to-speech/docs/authentication), [pricing](https://cloud.google.com/text-to-speech/pricing), and [supported voices](https://cloud.google.com/text-to-speech/docs/list-voices-and-types).
