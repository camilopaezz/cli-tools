# cli-tools

Upload a local file and get a public URL that expires.

## Install and use

From the repository root:

```sh
go install ./cmd/cli-tools
```

Set the upload token with `CLI_TOOLS_TOKEN`, or save it to the local config:

```sh
cli-tools auth set
```

Paste the token on stdin. Then upload:

```sh
cli-tools plan plan.html
cli-tools image screenshot.png
cli-tools video clip.mp4
cli-tools file archive.zip
```

`plan` accepts HTML up to 2 MiB. `image` accepts static PNG, JPEG, or WebP up to 10 MiB. `video` accepts MP4, M4V, WebM, or MOV up to 50 MiB. `file` accepts any non-empty file up to 100 MiB and downloads with its original filename.

The default expiry is 7 days, or 24 hours for `file`. Set `--ttl` with hours or days, up to 30 days, for example `cli-tools file archive.zip --ttl 2d`.

## Deploy the Worker

Create the R2 bucket once, set the upload token, then deploy:

```sh
cd worker
npm install
npx wrangler r2 bucket create cli-tools
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

Wrangler must be logged in to the Cloudflare account configured in `worker/wrangler.toml`. See [`worker/README.md`](worker/README.md) for the bucket lifecycle setup.
