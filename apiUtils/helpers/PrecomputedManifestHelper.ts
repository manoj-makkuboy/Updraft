import AdmZip from 'adm-zip';
import mime from 'mime';

import { HashHelper } from './HashHelper';
import { StorageFactory } from '../storage/StorageFactory';
import { getLogger } from '../logger';

const logger = getLogger('PrecomputedManifestHelper');

// Bump when the stored shape changes so stale artifacts are ignored.
const PRECOMPUTED_VERSION = 1;

// Suffix appended to an updateBundlePath to locate its precomputed manifest.
// e.g. updates/5.73.0/20260702120000 -> updates/5.73.0/20260702120000.manifest.json
const MANIFEST_SUFFIX = '.manifest.json';

export interface PrecomputedAsset {
  hash: string;
  key: string;
  fileExtension: string;
  contentType: string | null;
  filePath: string;
}

export interface PrecomputedPlatformManifest {
  id: string;
  assets: PrecomputedAsset[];
  launchAsset: PrecomputedAsset;
  expoConfig: any;
}

export interface PrecomputedManifest {
  version: number;
  createdAt: string;
  isRollback: boolean;
  platforms: {
    [platform: string]: PrecomputedPlatformManifest;
  };
}

function getManifestPath(updateBundlePath: string): string {
  return `${updateBundlePath}${MANIFEST_SUFFIX}`;
}

function buildAssetMetadata(
  zip: AdmZip,
  filePath: string,
  ext: string | null,
  isLaunchAsset: boolean
): PrecomputedAsset {
  const entry = zip.getEntry(filePath);
  if (!entry) {
    throw new Error(`File not found in zip: ${filePath}`);
  }
  const asset = entry.getData();

  const assetHash = HashHelper.getBase64URLEncoding(
    HashHelper.createHash(asset, 'sha256', 'base64')
  );
  const key = HashHelper.createHash(asset, 'md5', 'hex');
  const keyExtensionSuffix = isLaunchAsset ? 'bundle' : ext;
  const contentType = isLaunchAsset ? 'application/javascript' : mime.getType(ext ?? '');

  return {
    hash: assetHash,
    key,
    fileExtension: `.${keyExtensionSuffix}`,
    contentType,
    filePath,
  };
}

export class PrecomputedManifestHelper {
  /**
   * Reads the update zip ONCE and precomputes the per-platform manifest data
   * (asset hashes/keys, expo config, update id) that the manifest endpoint
   * would otherwise recompute — with a full ~tens-of-MB S3 download and
   * per-asset hashing — on every request. The result is stored as a small
   * JSON artifact next to the zip so the manifest endpoint can serve it with
   * a single tiny read and no hashing.
   */
  static async precomputeAndStore(updateBundlePath: string, zip: AdmZip): Promise<void> {
    const metadataEntry = zip.getEntry('metadata.json');
    if (!metadataEntry) {
      throw new Error('metadata.json not found in update zip');
    }
    const metadataBuffer = metadataEntry.getData();
    const metadataJson = JSON.parse(metadataBuffer.toString('utf-8'));
    const id = HashHelper.convertSHA256HashToUUID(
      HashHelper.createHash(metadataBuffer, 'sha256', 'hex')
    );

    const expoConfigEntry = zip.getEntry('expoconfig.json');
    const expoConfig = expoConfigEntry
      ? JSON.parse(expoConfigEntry.getData().toString('utf-8'))
      : {};

    const platforms: { [platform: string]: PrecomputedPlatformManifest } = {};
    for (const platform of Object.keys(metadataJson.fileMetadata ?? {})) {
      const platformMetadata = metadataJson.fileMetadata[platform];
      const assets: PrecomputedAsset[] = (platformMetadata.assets as any[]).map((asset: any) =>
        buildAssetMetadata(zip, asset.path, asset.ext, false)
      );
      const launchAsset = buildAssetMetadata(zip, platformMetadata.bundle, null, true);
      platforms[platform] = { id, assets, launchAsset, expoConfig };
    }

    const precomputed: PrecomputedManifest = {
      version: PRECOMPUTED_VERSION,
      createdAt: new Date().toISOString(),
      isRollback: zip.getEntry('rollback') !== null,
      platforms,
    };

    const storage = StorageFactory.getStorage();
    await storage.uploadFile(
      getManifestPath(updateBundlePath),
      Buffer.from(JSON.stringify(precomputed), 'utf-8')
    );
    logger.info('Stored precomputed manifest', {
      updateBundlePath,
      platforms: Object.keys(platforms),
    });
  }

  /**
   * Loads the precomputed manifest artifact for an update, or null when it is
   * missing / stale (e.g. releases uploaded before this optimization existed).
   * Callers fall back to computing the manifest from the zip on null.
   */
  static async tryGet(updateBundlePath: string): Promise<PrecomputedManifest | null> {
    const storage = StorageFactory.getStorage();
    const manifestPath = getManifestPath(updateBundlePath);
    try {
      const buffer = await storage.downloadFile(manifestPath);
      const parsed = JSON.parse(buffer.toString('utf-8')) as PrecomputedManifest;
      if (parsed.version !== PRECOMPUTED_VERSION) {
        logger.info('Ignoring stale precomputed manifest', {
          updateBundlePath,
          found: parsed.version,
          expected: PRECOMPUTED_VERSION,
        });
        return null;
      }
      return parsed;
    } catch {
      // Not found or unreadable — caller falls back to zip-based computation.
      return null;
    }
  }
}
