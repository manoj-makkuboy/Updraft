# Updraft — Self-Hosted OTA Updates for Expo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Hard fork of [xavia-io/xavia-ota](https://github.com/xavia-io/xavia-ota)** — batteries included.  
> Updraft keeps everything that made Xavia OTA great and layers in the production hardening, performance optimizations, and operational features that large-scale deployments need.

A self-hosted Over-The-Air (OTA) update server for Expo / React Native applications. Built with Next.js and TypeScript, it implements the full [expo-updates protocol](https://docs.expo.dev/archive/technical-specs/expo-updates-0/) while adding the features you actually need when running this in production.

---

## What's different from Xavia OTA

| | Xavia OTA (upstream) | Updraft (this fork) |
|---|---|---|
| Manifest serving | ~3s per request (full zip download + per-asset re-hashing on every request) | **Single-digit ms** — precomputed at upload time, served from a tiny JSON artifact |
| Existing releases | Served from zip on every request | Backfill endpoint generates precomputed artifacts for all existing releases in one call |
| User access management | Single shared `UPLOAD_KEY` | *(coming soon)* per-user API keys with role-based access |
| Maintenance | Upstream appears unmaintained | Actively maintained |

### Precomputed manifest optimization

Every manifest request used to download the entire update zip (~tens of MB from S3/blob storage), open it, and re-hash every asset — just to produce the same JSON it produced for every previous request. The CPU stayed near 0% the whole time because the server was simply waiting on network I/O. Adding more replicas or a bigger database had no effect because the bottleneck was this redundant work, not capacity.

Updraft eliminates this: at upload time, it does that work once and stores the result as a tiny `.manifest.json` artifact next to the zip. On every subsequent manifest request, it downloads that artifact (a few KB) instead of the full zip, assembles the response, and returns it. The fallback to zip-based computation is preserved automatically for any release that doesn't have a precomputed artifact yet.

See [docs/PRECOMPUTED_MANIFEST.md](./docs/PRECOMPUTED_MANIFEST.md) for a detailed explanation.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Deployment](#deployment)
- [Local Development](#local-development)
- [Backfill Existing Releases](#backfill-existing-releases)
- [Code Signing](#code-signing)
- [React Native App Configuration](#react-native-app-configuration)
- [Publish App Update](#publish-app-update)
- [Rollbacks](#rollbacks)
- [Admin Dashboard](#admin-dashboard)
- [Technical Stack](#technical-stack)
- [FAQ](#faq)
- [License](#license)

---

## Overview

Updraft provides a robust OTA update infrastructure built around four components:

1. **Updates Server** — Next.js application handling OTA update distribution with the precomputed manifest fast path.
2. **Admin Dashboard** — Web interface for release management, rollbacks, and download analytics.
3. **Blob Storage** — Pluggable interface: AWS S3, S3-compatible, Google Cloud Storage, Supabase, or local filesystem.
4. **Database Layer** — PostgreSQL for release tracking, download metrics, and version management. No sensitive or personal data is collected.

---

## Key Features

- **Full expo-updates protocol compatibility** — drop-in replacement for EAS Updates; no app-side changes beyond pointing `updates.url` at your server.
- **Precomputed manifests** — manifest serving in single-digit milliseconds; no per-request zip downloads or asset re-hashing.
- **Backfill endpoint** — one API call generates precomputed artifacts for all existing releases.
- **Runtime version management and rollbacks** — roll forward or back to any previous release from the admin dashboard.
- **Multiple blob storage backends** — S3, S3-compatible, GCS, Supabase, local filesystem.
- **Release history tracking** — every release carries a timestamp, commit hash, and commit message.
- **Download analytics** — per-platform, per-release download counts.
- **Docker-first deployment** — single `docker-compose up` gets you running.
- **Code signing** — optional RSA key-pair signing for update verification on the client.

---

## Deployment

### Docker Compose (recommended)

Copy the production compose file and configure your environment:

```bash
cp containers/prod/docker-compose.yml ./docker-compose.yml
# Edit docker-compose.yml and fill in the environment variables below
docker compose up -d
```

### Required environment variables

```env
HOST=https://your-public-domain.com      # Full public URL — used to build asset download URLs
BLOB_STORAGE_TYPE=s3-iam                 # s3 | s3-iam | gcs | supabase | local
DB_TYPE=postgres
ADMIN_PASSWORD=your-admin-password
UPLOAD_KEY=your-secret-upload-key
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=releases_db
POSTGRES_HOST=your-db-host
POSTGRES_PORT=5432

# For S3 / S3-IAM
S3_BUCKET_NAME=your-bucket
AWS_REGION=us-east-1
# For s3 (explicit keys, not IAM role):
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...

# Optional: code signing
# PRIVATE_KEY_BASE_64=<base64-encoded RSA private key>
```

> **`HOST` must be your public-facing URL.** If it is wrong (e.g. `localhost:3000` in a cloud deployment), the asset URLs embedded in every manifest will be unreachable from devices.

### AWS ECS / Fargate

See [docs/aws-deployment.md](./docs/aws-deployment.md) for a step-by-step guide covering ECR, ECS Fargate, Aurora Serverless v2, RDS Proxy, ALB, and CloudFront.

### Load testing your deployment

See [docs/load_testing.md](./docs/load_testing.md) for k6 scripts and guidance on interpreting results. Run the load test from a machine in the same region as your server — a laptop connecting across continents will saturate the client's network before it stresses the server.

---

## Local Development

```bash
git clone https://github.com/your-org/updraft.git
cd updraft
npm install
cp .env.example.local .env.local
# Fill in .env.local
npm run dev
```

The server and admin dashboard will be available at `http://localhost:3000`.

See [docs/supportedStorageAlternatives.md](./docs/supportedStorageAlternatives.md) for full storage and database configuration options.

---

## Backfill Existing Releases

Releases uploaded before the precomputed manifest feature existed will continue to work via the fallback path (zip download per request). To generate precomputed artifacts for all of them in one go, call the backfill endpoint from inside your network (it requires your `UPLOAD_KEY`):

```bash
curl -X POST https://your-domain.com/api/backfill-manifests \
  -H "Content-Type: application/json" \
  -d '{"uploadKey": "your-upload-key"}'
```

The endpoint iterates every release in the database, skips any that already have a precomputed artifact, and generates the missing ones. It returns a summary of how many were processed, skipped, and failed. Runs in the background if you add `"async": true` to the body.

On ECS / Fargate the task role has S3 access, so no additional credentials are needed.

---

## Code Signing

Code signing uses an RSA private key to sign updates; clients verify with the corresponding certificate. To generate keys:

```bash
# Generate private key
openssl genrsa -out private-key.pem 2048
# Export as base64 for the env var
base64 -i private-key.pem | tr -d '\n'
```

Refer to the [Expo code signing documentation](https://docs.expo.dev/eas-update/code-signing/) for the client-side setup.

---

## React Native App Configuration

Point `expo-updates` at your server in `app.json` / `app.config.js`:

```json
{
  "expo": {
    "updates": {
      "url": "https://your-domain.com/api/manifest"
    },
    "runtimeVersion": "1.0.0"
  }
}
```

> ⚠️ The URL must end in `/api/manifest`. Pointing it at the root returns the admin dashboard HTML and the update check will silently fail.

See the [expo-updates SDK docs](https://docs.expo.dev/versions/latest/sdk/updates/) for full configuration options.

---

## Publish App Update

Use the provided script from your React Native app root:

```bash
# Copy the script once
cp <updraft-repo>/scripts/build-and-publish-app-release.sh .
chmod +x build-and-publish-app-release.sh

# Publish
./build-and-publish-app-release.sh <runtimeVersion> <server-url> <uploadKey>
```

Example:
```bash
./build-and-publish-app-release.sh 1.0.0 https://your-domain.com abc123def456
```

The script will:
1. Run `expo export` to build the JS bundle and assets.
2. Package the output with metadata into a zip.
3. Prompt you to confirm the commit hash and message.
4. Upload to your Updraft server.

> The `runtimeVersion` must match the value in your `app.json`. Mismatched runtime versions will result in no update being served.

---

## Rollbacks

Updraft uses a roll-forward rollback strategy: clicking "Rollback" in the admin dashboard copies the target release with a new timestamp, making it the current active release. No data is deleted. The previous active release becomes inactive but remains in storage and can be rolled back to again.

---

## Admin Dashboard

Access the admin dashboard at `https://your-domain.com`. Log in with your `ADMIN_PASSWORD`.

From the dashboard you can:
- View all releases with commit metadata and download counts.
- Promote any previous release to active (rollback).
- Monitor per-platform download analytics.

See [docs/adminPortal.md](./docs/adminPortal.md) for screenshots and a full feature walkthrough.

---

## Technical Stack

### Core
- **Framework**: Next.js 15+
- **Language**: TypeScript
- **Database**: PostgreSQL 14+
- **UI**: Chakra UI v2 + Tailwind CSS
- **Container**: Docker & Docker Compose

### Storage backends
| Backend | `BLOB_STORAGE_TYPE` value | Notes |
|---|---|---|
| AWS S3 (IAM role) | `s3-iam` | Recommended for ECS / EC2 |
| AWS S3 (explicit keys) | `s3` | For non-AWS environments |
| Google Cloud Storage | `gcs` | |
| Supabase Storage | `supabase` | |
| Local filesystem | `local` | Development only |

### Development tools
- Jest for unit + integration tests
- ESLint for code quality
- Docker for containerization

---

## FAQ

<details>
<summary>

### How is this different from EAS Updates?
</summary>

EAS Updates is a managed service with per-update pricing that becomes expensive at scale. Updraft is self-hosted and free. Both implement the same expo-updates protocol, so switching is a one-line change to `updates.url` in your app config.
</details>

<details>
<summary>

### How is this different from the original Xavia OTA?
</summary>

Updraft is a hard fork of [xavia-io/xavia-ota](https://github.com/xavia-io/xavia-ota). The upstream project appears to be unmaintained. Updraft adds:

- **Precomputed manifests**: eliminates the per-request S3 zip download that caused ~3s TTFB under load.
- **Backfill endpoint**: retroactively generates precomputed artifacts for existing releases.
- Active maintenance and production-hardening focus.

The expo-updates protocol implementation and the storage/database abstractions are inherited from Xavia OTA.
</details>

<details>
<summary>

### How is this different from self-hosted CodePush?
</summary>

The self-hosted CodePush server is tightly coupled to Azure (App Service + Azure Blob Storage + Azurite for local dev). Updraft is cloud-agnostic — deploy on AWS, GCP, any VPS, or your own hardware. Updraft also implements the expo-updates protocol which is more widely adopted in the Expo / React Native ecosystem than CodePush's protocol.
</details>

<details>
<summary>

### Can I use this with bare React Native apps?
</summary>

Yes, with a caveat. You need to install `expo-updates` in your app and point it at your Updraft server. That brings a small Expo footprint into your app — you won't need EAS Build or EAS Submit, but `expo-updates` itself is an Expo package. The server side is fully protocol-compliant and works with any client that speaks the expo-updates protocol.
</details>

<details>
<summary>

### What blob storage options are supported?
</summary>

- AWS S3 with IAM role (`s3-iam`) — recommended for ECS/EC2
- AWS S3 with explicit credentials (`s3`)
- Google Cloud Storage (`gcs`)
- Supabase Storage (`supabase`)
- Local filesystem (`local`) — development only

Additional backends can be added by implementing the `StorageInterface`.
</details>

<details>
<summary>

### What database options are supported?
</summary>

PostgreSQL only, for now. The `DatabaseInterface` is straightforward to implement for other databases — contributions welcome.
</details>

<details>
<summary>

### Is this production-ready?
</summary>

Yes. The expo-updates protocol implementation is inherited from Xavia OTA (which was production-tested) and Updraft's additions (precomputed manifests, backfill) are covered by the existing test suite. The performance optimization has been load-tested on AWS ECS Fargate + Aurora Serverless v2 + CloudFront.
</details>

---

## License

MIT — see [LICENSE](./LICENSE).

---

*Forked from [xavia-io/xavia-ota](https://github.com/xavia-io/xavia-ota). Original work © xavia-io contributors, licensed MIT.*
