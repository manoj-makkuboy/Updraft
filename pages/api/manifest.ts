import FormData from 'form-data';

import { NextApiRequest, NextApiResponse } from 'next';
import { serializeDictionary } from 'structured-headers';

import { ConfigHelper } from '../../apiUtils/helpers/ConfigHelper';
import { DictionaryHelper } from '../../apiUtils/helpers/DictionaryHelper';
import { HashHelper } from '../../apiUtils/helpers/HashHelper';
import { UpdateHelper, NoUpdateAvailableError } from '../../apiUtils/helpers/UpdateHelper';
import { ZipHelper } from '../../apiUtils/helpers/ZipHelper';
import {
  PrecomputedManifest,
  PrecomputedManifestHelper,
} from '../../apiUtils/helpers/PrecomputedManifestHelper';
import { getLogger } from '../../apiUtils/logger';
import { DatabaseFactory } from '../../apiUtils/database/DatabaseFactory';
import moment from 'moment';

const logger = getLogger('manifest');

// Manifest and NoUpdateAvailable responses are fully determined by the expo-*
// request headers (platform, runtime-version, current-update-id,
// protocol-version, expect-signature). As long as the CloudFront cache key
// includes those headers, a shared CDN can safely serve one origin computation
// to the whole fleet during an update blast. `max-age=0` keeps the client
// (phone) always revalidating so a new release is picked up immediately;
// `s-maxage` lets CloudFront absorb the herd for a short window.
//
// NOTE: rollback responses intentionally stay `private` — they additionally
// vary by expo-embedded-update-id, which is NOT part of the CDN cache key, so
// caching them could serve the wrong directive.
const MANIFEST_CACHE_CONTROL = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

export default async function manifestEndpoint(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.json({ error: 'Expected GET.' });
    return;
  }

  logger.info('A client requested a release', {
    runtimeVersion: req.headers['expo-runtime-version'],
    platform: req.headers['expo-platform'],
    protocolVersion: req.headers['expo-protocol-version'],
    apiVersion: req.headers['expo-api-version'],
    currentUpdateId: req.headers['expo-current-update-id'],
  });

  const protocolVersionMaybeArray = req.headers['expo-protocol-version'];
  if (protocolVersionMaybeArray && Array.isArray(protocolVersionMaybeArray)) {
    res.statusCode = 400;
    res.json({
      error: 'Unsupported protocol version. Expected either 0 or 1.',
    });
    return;
  }

  const protocolVersion = parseInt(protocolVersionMaybeArray ?? '0', 10);

  const platform = req.headers['expo-platform'] ?? req.query['platform'];
  if (platform !== 'ios' && platform !== 'android') {
    res.statusCode = 400;
    res.json({
      error: 'Unsupported platform. Expected either ios or android.',
    });
    return;
  }

  const runtimeVersion = req.headers['expo-runtime-version'] ?? req.query['runtime-version'];
  if (!runtimeVersion || typeof runtimeVersion !== 'string') {
    res.statusCode = 400;
    res.json({
      error: 'No runtimeVersion provided.',
    });
    return;
  }

  const database = DatabaseFactory.getDatabase();
  const releaseRecord = await database.getLatestReleaseRecordForRuntimeVersion(runtimeVersion);

  if (releaseRecord) {
    const updateId = releaseRecord.updateId;

    const currentUpdateId = req.headers['expo-current-update-id'];
    if (currentUpdateId === updateId) {
      logger.info('User is already running the latest release. Returning NoUpdateAvailable.', {
        runtimeVersion,
      });
      await putNoUpdateAvailableInResponseAsync(req, res, protocolVersion);
      return;
    }
  }

  let updateBundlePath: string;
  try {
    updateBundlePath = await UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync(
      runtimeVersion
    );
  } catch (error: any) {
    if (error instanceof NoUpdateAvailableError) {
      logger.info('No update available for runtime version', { runtimeVersion });
      await putNoUpdateAvailableInResponseAsync(req, res, protocolVersion);
      return;
    }

    res.statusCode = 404;
    res.json({
      error: error.message,
    });
    return;
  }

  // Fast path: a manifest artifact precomputed at upload time lets us skip
  // downloading the full update zip and re-hashing every asset per request.
  // Falls back to zip-based computation when the artifact is absent (older
  // releases) or unreadable.
  const precomputed = await PrecomputedManifestHelper.tryGet(updateBundlePath);

  const updateType = await getTypeOfUpdateAsync(updateBundlePath, precomputed);

  try {
    try {
      if (updateType === UpdateType.NORMAL_UPDATE) {
        logger.info('Found a normal update available.');
        await putUpdateInResponseAsync(
          req,
          res,
          updateBundlePath,
          runtimeVersion,
          platform,
          protocolVersion,
          precomputed
        );
      } else if (updateType === UpdateType.ROLLBACK) {
        logger.info('Rollback is available.');
        await putRollBackInResponseAsync(req, res, updateBundlePath, protocolVersion);
      }
    } catch (maybeNoUpdateAvailableError) {
      if (maybeNoUpdateAvailableError instanceof NoUpdateAvailableError) {
        logger.info('psych!! User already running latest available update');
        await putNoUpdateAvailableInResponseAsync(req, res, protocolVersion);
        return;
      }
      throw maybeNoUpdateAvailableError;
    }
  } catch (error) {
    logger.error(error);
    res.statusCode = 404;
    res.json({ error });
  }
}

enum UpdateType {
  NORMAL_UPDATE,
  ROLLBACK,
}

async function getTypeOfUpdateAsync(
  updateBundlePath: string,
  precomputed: PrecomputedManifest | null
): Promise<UpdateType> {
  if (precomputed) {
    return precomputed.isRollback ? UpdateType.ROLLBACK : UpdateType.NORMAL_UPDATE;
  }
  const zip = await ZipHelper.getZipFromStorage(updateBundlePath);
  const hasRollback = zip.getEntry('rollback') !== null;
  return hasRollback ? UpdateType.ROLLBACK : UpdateType.NORMAL_UPDATE;
}

function buildAssetUrl(
  filePath: string,
  runtimeVersion: string,
  platform: string
): string {
  return `${process.env.HOST}/api/assets?asset=${filePath}&runtimeVersion=${runtimeVersion}&platform=${platform}`;
}

async function putUpdateInResponseAsync(
  req: NextApiRequest,
  res: NextApiResponse,
  updateBundlePath: string,
  runtimeVersion: string,
  platform: string,
  protocolVersion: number,
  precomputed: PrecomputedManifest | null
): Promise<void> {
  const currentUpdateId = req.headers['expo-current-update-id'];

  let manifest: any;

  if (precomputed && precomputed.platforms[platform]) {
    // Fast path — no zip download, no per-asset hashing. Asset URLs are built
    // from the current HOST so the artifact stays valid if HOST changes.
    const platformManifest = precomputed.platforms[platform];

    if (currentUpdateId === platformManifest.id && protocolVersion === 1) {
      logger.info('returning NoUpdateAvailable to client');
      throw new NoUpdateAvailableError();
    }

    const toManifestAsset = (asset: (typeof platformManifest.assets)[number]) => ({
      hash: asset.hash,
      key: asset.key,
      fileExtension: asset.fileExtension,
      contentType: asset.contentType,
      url: buildAssetUrl(asset.filePath, runtimeVersion, platform),
    });

    manifest = {
      id: platformManifest.id,
      createdAt: precomputed.createdAt,
      runtimeVersion,
      assets: platformManifest.assets.map(toManifestAsset),
      launchAsset: toManifestAsset(platformManifest.launchAsset),
      metadata: {},
      extra: {
        expoClient: platformManifest.expoConfig,
      },
    };
  } else {
    // Fallback — compute from the zip (older releases without a precomputed
    // artifact). Same behavior as before this optimization.
    const { metadataJson, createdAt, id } = await UpdateHelper.getMetadataAsync({
      updateBundlePath,
      runtimeVersion,
    });

    // NoUpdateAvailable directive only supported on protocol version 1
    // for protocol version 0, serve most recent update as normal
    if (currentUpdateId === HashHelper.convertSHA256HashToUUID(id) && protocolVersion === 1) {
      logger.info('returning NoUpdateAvailable to client');
      throw new NoUpdateAvailableError();
    }

    const expoConfig = await ConfigHelper.getExpoConfigAsync({
      updateBundlePath,
      runtimeVersion,
    });
    const platformSpecificMetadata = metadataJson.fileMetadata[platform];
    manifest = {
      id: HashHelper.convertSHA256HashToUUID(id),
      createdAt,
      runtimeVersion,
      assets: await Promise.all(
        (platformSpecificMetadata.assets as any[]).map((asset: any) =>
          UpdateHelper.getAssetMetadataAsync({
            updateBundlePath,
            filePath: asset.path,
            ext: asset.ext,
            runtimeVersion,
            platform,
            isLaunchAsset: false,
          })
        )
      ),
      launchAsset: await UpdateHelper.getAssetMetadataAsync({
        updateBundlePath,
        filePath: platformSpecificMetadata.bundle,
        isLaunchAsset: true,
        runtimeVersion,
        platform,
        ext: null,
      }),
      metadata: {},
      extra: {
        expoClient: expoConfig,
      },
    };
  }

  let signature = null;
  const expectSignatureHeader = req.headers['expo-expect-signature'];
  if (expectSignatureHeader) {
    const privateKey = ConfigHelper.getPrivateKey();
    if (!privateKey) {
      res.statusCode = 400;
      res.json({
        error: 'Code signing requested but no key supplied when starting server.',
      });
      return;
    }
    const manifestString = JSON.stringify(manifest);
    const hashSignature = HashHelper.signRSASHA256(manifestString, privateKey);
    const dictionary = DictionaryHelper.convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: 'main',
    });
    signature = serializeDictionary(dictionary);
  }

  const assetRequestHeaders: { [key: string]: object } = {};
  [...manifest.assets, manifest.launchAsset].forEach((asset) => {
    assetRequestHeaders[asset.key] = {
      'test-header': 'test-header-value',
    };
  });

  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });
  form.append('extensions', JSON.stringify({ assetRequestHeaders }), {
    contentType: 'application/json',
  });

  res.statusCode = 200;
  res.setHeader('expo-protocol-version', protocolVersion);
  res.setHeader('expo-sfv-version', 0);
  res.setHeader('cache-control', MANIFEST_CACHE_CONTROL);
  res.setHeader('content-type', `multipart/mixed; boundary=${form.getBoundary()}`);
  res.write(form.getBuffer());
  res.end();

  const database = DatabaseFactory.getDatabase();
  const release = await database.getReleaseByPath(updateBundlePath + '.zip');

  if (release) {
    logger.info(`Tracking download for release.`, { releaseId: release.id });
    await database.createTracking({
      platform,
      releaseId: release.id,
      downloadTimestamp: moment().utc().toISOString(),
    });
  }
}

async function putRollBackInResponseAsync(
  req: NextApiRequest,
  res: NextApiResponse,
  updateBundlePath: string,
  protocolVersion: number
): Promise<void> {
  if (protocolVersion === 0) {
    logger.error('Rollbacks not supported on protocol version 0');
    throw new Error('Rollbacks not supported on protocol version 0');
  }

  const embeddedUpdateId = req.headers['expo-embedded-update-id'];
  if (!embeddedUpdateId || typeof embeddedUpdateId !== 'string') {
    logger.error('Invalid Expo-Embedded-Update-ID request header specified.');
    throw new Error('Invalid Expo-Embedded-Update-ID request header specified.');
  }

  const currentUpdateId = req.headers['expo-current-update-id'];
  if (currentUpdateId === embeddedUpdateId) {
    logger.error('Found update already exists in the client.');
    throw new NoUpdateAvailableError();
  }

  const directive = await UpdateHelper.createRollBackDirectiveAsync(updateBundlePath);

  let signature = null;
  const expectSignatureHeader = req.headers['expo-expect-signature'];
  if (expectSignatureHeader) {
    const privateKey = ConfigHelper.getPrivateKey();
    if (!privateKey) {
      res.statusCode = 400;
      res.json({
        error: 'Code signing requested but no key supplied when starting server.',
      });
      return;
    }
    const directiveString = JSON.stringify(directive);
    const hashSignature = HashHelper.signRSASHA256(directiveString, privateKey);
    const dictionary = DictionaryHelper.convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: 'main',
    });
    signature = serializeDictionary(dictionary);
  }

  const form = new FormData();
  form.append('directive', JSON.stringify(directive), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });

  res.statusCode = 200;
  res.setHeader('expo-protocol-version', 1);
  res.setHeader('expo-sfv-version', 0);
  res.setHeader('cache-control', 'private, max-age=0');
  res.setHeader('content-type', `multipart/mixed; boundary=${form.getBoundary()}`);
  res.write(form.getBuffer());
  res.end();
}

async function putNoUpdateAvailableInResponseAsync(
  req: NextApiRequest,
  res: NextApiResponse,
  protocolVersion: number
): Promise<void> {
  if (protocolVersion === 0) {
    throw new Error('NoUpdateAvailable directive not available in protocol version 0');
  }

  const directive = await UpdateHelper.createNoUpdateAvailableDirectiveAsync();

  let signature = null;
  const expectSignatureHeader = req.headers['expo-expect-signature'];
  if (expectSignatureHeader) {
    const privateKey = ConfigHelper.getPrivateKey();
    if (!privateKey) {
      res.statusCode = 400;
      res.json({
        error: 'Code signing requested but no key supplied when starting server.',
      });
      return;
    }
    const directiveString = JSON.stringify(directive);
    const hashSignature = HashHelper.signRSASHA256(directiveString, privateKey);
    const dictionary = DictionaryHelper.convertToDictionaryItemsRepresentation({
      sig: hashSignature,
      keyid: 'main',
    });
    signature = serializeDictionary(dictionary);
  }

  const form = new FormData();
  form.append('directive', JSON.stringify(directive), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });

  res.statusCode = 200;
  res.setHeader('expo-protocol-version', 1);
  res.setHeader('expo-sfv-version', 0);
  res.setHeader('cache-control', MANIFEST_CACHE_CONTROL);
  res.setHeader('content-type', `multipart/mixed; boundary=${form.getBoundary()}`);
  res.write(form.getBuffer());
  res.end();
}
