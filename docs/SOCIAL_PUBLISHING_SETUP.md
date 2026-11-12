# FacelessLab social publishing setup

## OAuth callback URLs

Register these exact callback URLs with each provider:

- YouTube / Google: `https://facelesslab-api.joshdrn18.workers.dev/api/publishing/oauth/youtube/callback`
- TikTok: `https://facelesslab-api.joshdrn18.workers.dev/api/publishing/oauth/tiktok/callback`

## Cloudflare Worker secrets

Set these as Worker secrets (never commit them or paste them into chat):

- `PUBLISH_TOKEN_ENCRYPTION_KEY`: base64 encoding of exactly 32 random bytes (AES-256-GCM).
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`

The two client ID/secret pairs are provider credentials. The encryption key protects each user's OAuth access and refresh tokens before they are stored in D1.

## Google / YouTube

1. Create or select a Google Cloud project and enable YouTube Data API v3.
2. Configure an OAuth web application and add the YouTube callback URL above as an authorized redirect URI.
3. Request the `https://www.googleapis.com/auth/youtube.upload` scope.
4. If the OAuth consent screen is in testing mode, add the channel owner as a test user.

The Worker uploads using YouTube's resumable upload endpoint. A successful upload is saved with its YouTube video ID and Shorts URL.

## TikTok

1. Register an app in TikTok for Developers and add the Content Posting API product.
2. Add the TikTok callback URL above.
3. Request `user.info.basic`, `video.upload`, and `video.publish`.
4. Enable Direct Post and complete TikTok's required app review/audit before expecting public posts.

TikTok Direct Post requires a creator-info query before posting and the creator's selected privacy level must be one of the options TikTok returns. Un-audited apps are restricted to private viewing. FacelessLab marks generated videos as AI-generated content in the TikTok post metadata.

## Deployment

After secrets are configured, run the GitHub Actions workflow **Deploy FacelessLab API**. The workflow requires a GitHub repository secret named `CLOUDFLARE_API_TOKEN` with permission to deploy Workers in the FacelessLab Cloudflare account.

The Pages interface can be deployed independently. OAuth and publishing API routes only become active after the Worker deployment succeeds.
