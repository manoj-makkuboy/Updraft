# Precomputed Manifest — Why and How

> A deep-dive, written for someone new to backend development, explaining the
> performance change made to the Xavia OTA manifest endpoint.

---

## 1. Background: what does this server actually do?

Xavia OTA is a server that lets your mobile app download JavaScript updates
**over-the-air (OTA)** — without going through the App Store. When your app
starts, the `expo-updates` library on the phone asks the server one question:

> "I'm running app version `5.73.0` on `ios`. Is there a newer JavaScript
> bundle I should download?"

That question is an HTTP request to the **manifest endpoint**:

```
GET https://<your-server>/api/manifest
```

The server answers with a **manifest** — a JSON document that describes the
latest update:

- a unique `id` for the update,
- a list of **assets** (images, fonts, etc.) with their download URLs,
- the **launch asset** (the actual JavaScript bundle),
- some config.

The phone reads the manifest, decides "yes this is new," and downloads the
files listed in it.

So the manifest endpoint is the **front door** of the whole system. Every
single app launch hits it. If it's slow, *everything* feels slow — and during a
big moment (e.g. you push an update and send a notification to all users), tens
of thousands of phones hit it within seconds.

---

## 2. The problem: the front door was slow (~3 seconds)

We measured the manifest endpoint under load and found each request took
**about 3 seconds** to respond. Worse, while it was being slow, the server's
CPU was almost idle (~1%). That combination — *slow but not busy* — is a huge
clue. It means the server wasn't **working hard**; it was **waiting** for
something.

### What was it waiting for?

To build the manifest, the old code did this **on every single request**:

1. **Download the entire update `.zip` from storage (S3).** This zip contains
   the whole JavaScript bundle plus every asset — for a real app that's tens of
   megabytes. Downloading tens of MB from S3 takes time, and the CPU just sits
   there waiting for the network. That's your ~3 seconds.

2. **Open the zip and read files out of it.**

3. **Compute a cryptographic hash (SHA-256 + MD5) of every asset**, one by one,
   to fill in the manifest.

4. Read `metadata.json` and `expoconfig.json` from the zip too.

Here's the key insight: **the answer to all of that work is the same every
time.** The update bundle doesn't change after it's uploaded. Its assets don't
change. Their hashes don't change. Yet the server was recomputing the identical
answer from scratch for every phone that asked.

> **Analogy.** Imagine a restaurant where, every time a customer asks "what's
> today's menu?", the chef walks to the warehouse, unpacks every box of
> ingredients, weighs each one, and *then* writes out the menu. The menu is the
> same for every customer all day — but the chef redoes the whole warehouse
> trip for each person. That warehouse trip is the 3 seconds.

### Why adding servers didn't help

Before finding this, the instinct was "the server is overloaded, add more
copies (ECS tasks) / a bigger database." But we checked the metrics: CPU, memory,
and the database were all **idle** during the load test. The bottleneck wasn't
capacity — it was a **slow algorithm that runs once per request**. Ten idle
chefs each making the same slow warehouse trip is still slow. You have to fix
the *trip*, not hire more chefs.

---

## 3. The fix: do the slow work once, not per request

The technique is called **precomputation** (a form of **caching**). The idea:

> Do the expensive work **once, when the update is uploaded**, save the result,
> and then just **read the saved result** every time a phone asks.

The update is uploaded rarely (once per release). Phones ask for the manifest
constantly (every launch). So moving the work from "per request" to "per
upload" is a massive win — we trade a tiny bit of extra work at upload time for
enormous savings on every one of the millions of reads.

> **Back to the analogy.** Now, when a new shipment of ingredients arrives
> (upload), the chef does the warehouse trip **once** and pins the finished menu
> to the wall. When customers ask (manifest request), the chef just points at
> the wall. Instant.

---

## 4. What actually changed in the code

Three pieces were added/modified. Let's walk through each.

### 4.1 New file: `apiUtils/helpers/PrecomputedManifestHelper.ts`

This is the "menu writer and menu reader." It has two main functions:

#### `precomputeAndStore(updateBundlePath, zip)` — writes the menu

Called **once at upload time**. It:

1. Reads `metadata.json` from the zip to learn which assets exist for each
   platform (`ios`, `android`).
2. For every asset, computes its `hash` and `key` (the same SHA-256/MD5 work
   the old code did per request — but now just once).
3. Reads `expoconfig.json`.
4. Detects whether this update is a "rollback."
5. Packs all of that into a small JSON object and **saves it to storage** right
   next to the zip, with a `.manifest.json` name.

So if the zip lives at:

```
updates/5.73.0/20260702120000.zip
```

the precomputed file lives at:

```
updates/5.73.0/20260702120000.manifest.json
```

This file is **tiny** (a few kilobytes) — it contains hashes and file paths,
**not** the actual asset bytes. That's why reading it later is fast.

#### `tryGet(updateBundlePath)` — reads the menu

Called at manifest-serving time. It downloads that small `.manifest.json` and
returns it. If the file isn't there (an older update, uploaded before this
feature existed), it returns `null` — a signal that means "no precomputed menu,
fall back to the old slow way." More on that fallback below.

There's also a `version` number stored in the file. If we ever change the shape
of the precomputed data in the future, we bump the version; old files with a
mismatched version are ignored (treated as "not found") so we never serve stale
or malformed data.

### 4.2 `pages/api/upload.ts` — generate the menu on upload

The upload endpoint already had the zip open in memory to read `metadata.json`.
We added a few lines: right after the zip is saved to storage, call
`precomputeAndStore(...)`.

Importantly, this is wrapped in a `try/catch` and is **non-fatal**: if
precomputation somehow fails, the upload still succeeds and we just log a
warning. The manifest endpoint will fall back to the slow path for that update.
This is a safety principle — **an optimization should never break the core
feature.**

### 4.3 `pages/api/manifest.ts` — read the menu instead of rebuilding it

This is where the speed payoff happens. The handler now:

1. Figures out which update is the latest (a fast database lookup — unchanged).
2. Calls `PrecomputedManifestHelper.tryGet(...)`.
3. **If a precomputed manifest exists (the fast path):** build the response
   directly from it. No zip download. No hashing. Just assemble the JSON and
   send it. This is the single-digit-millisecond path.
4. **If it doesn't exist (the fallback path):** run the original code exactly as
   before — download the zip, hash everything, etc.

#### One subtle but important detail: asset URLs

The precomputed file stores each asset's **file path** (like
`assets/logo.png`), but **not** its full download URL. The full URL is built
*at request time* like this:

```
${process.env.HOST}/api/assets?asset=<filePath>&runtimeVersion=...&platform=...
```

Why not store the full URL? Because the URL contains `HOST` — your server's
public address (the CloudFront URL). If you ever change `HOST` (new domain, new
CDN), a stored URL would become wrong. By storing only the stable, content-based
parts (hashes, paths) and building the URL fresh each time, the precomputed file
stays correct forever, even if your domain changes. **We cache the parts that
never change, and compute the parts that might.**

> Fun fact: this is the exact bug you hit earlier in the project — asset URLs
> pointing at `localhost:3000` because `HOST` wasn't set. Building the URL from
> `HOST` at request time keeps that concern in one place.

#### Another detail: the rollback check

The old code also downloaded the whole zip just to check "is this a rollback
update?" (a rollback tells the phone to revert to a previous version). We now
store that `isRollback` flag in the precomputed file too, so even that check no
longer needs the zip.

---

## 5. Before vs. after (request flow)

**Before — every manifest request:**

```
phone → /api/manifest
          ├─ look up latest release in DB            (fast)
          ├─ download ENTIRE update zip from S3       (SLOW — tens of MB, ~3s)
          ├─ open zip, read metadata.json
          ├─ hash EVERY asset (SHA-256 + MD5)         (repeated work)
          ├─ read expoconfig.json
          └─ assemble JSON → respond
        total: ~3 seconds
```

**After — every manifest request (fast path):**

```
phone → /api/manifest
          ├─ look up latest release in DB             (fast)
          ├─ download tiny .manifest.json from S3      (fast — a few KB)
          ├─ build asset URLs from HOST
          └─ assemble JSON → respond
        total: single-digit milliseconds
```

The expensive work (zip download + hashing) moved to **upload time**, which
happens once per release instead of once per request.

---

## 6. Why this is safe (backward compatibility)

- **Old updates still work.** Any update uploaded before this change has no
  `.manifest.json`. For those, `tryGet` returns `null` and the server uses the
  original slow-but-correct code. Nothing breaks.
- **The output is byte-for-byte the same shape.** The manifest JSON the phone
  receives is identical whether it came from the fast path or the fallback. The
  phone can't tell the difference — it just gets its answer faster.
- **Precompute failure can't block uploads.** If precomputation errors out, the
  upload still succeeds and serving falls back gracefully.

---

## 7. How to roll it out

1. **Rebuild and redeploy the Xavia server** with these code changes (rebuild
   the Docker image for `linux/amd64`, push to ECR, force a new ECS deployment).

2. **Generate precomputed files for your *existing* updates.** New uploads get
   a `.manifest.json` automatically. Updates uploaded *before* this change don't
   have one yet, so they'd still use the slow fallback until you either:
   - re-publish them (running the publish script again), or
   - run a **backfill** that generates the `.manifest.json` for every existing
     update (a backfill endpoint/script can be added for this).

3. **Re-run the load test.** Ideally from a machine in the same AWS region
   (e.g. an EC2 instance in `us-east-1`) so the test measures the server, not
   your laptop's distance from the server. You should see the manifest response
   time drop from seconds to milliseconds.

---

## 8. Glossary (quick reference)

- **Manifest** — the JSON "menu" describing the latest update; what the phone
  asks for on launch.
- **Asset** — a file inside the update (image, font, the JS bundle).
- **Hash** — a short fingerprint computed from a file's contents; used to verify
  integrity and identify files. Computing it requires reading the whole file.
- **S3 / blob storage** — where the update zips are stored in the cloud.
- **Precomputation / caching** — doing expensive work once and saving the result
  so you don't redo it every time.
- **Fast path / fallback path** — the optimized route (uses the saved result)
  vs. the original route (recomputes from scratch) used when no saved result
  exists.
- **`HOST`** — an environment variable holding your server's public URL; used to
  build asset download links.
- **I/O-bound vs CPU-bound** — "I/O-bound" means slow because it's *waiting*
  (network, disk); "CPU-bound" means slow because it's *calculating*. Our
  problem was I/O-bound (waiting on the S3 download), which is why the CPU looked
  idle.

---

## 9. Files changed

| File | Change |
|------|--------|
| `apiUtils/helpers/PrecomputedManifestHelper.ts` | **New.** Writes (`precomputeAndStore`) and reads (`tryGet`) the small precomputed manifest artifact. |
| `pages/api/upload.ts` | Calls `precomputeAndStore` after saving the zip (non-fatal). |
| `pages/api/manifest.ts` | Uses the precomputed artifact when present (fast path); falls back to the original zip-based logic otherwise. |
| `__tests__/manifest.test.ts` | New tests proving the fast path serves correctly and never downloads the zip. |
