import mime from 'mime';
import { NextApiRequest, NextApiResponse } from 'next';
import nullthrows from 'nullthrows';

import { UpdateHelper } from '../../apiUtils/helpers/UpdateHelper';
import { ZipHelper } from '../../apiUtils/helpers/ZipHelper';

export default async function assetsEndpoint(req: NextApiRequest, res: NextApiResponse) {
  const { asset: assetPath, runtimeVersion, platform } = req.query;

  if (!assetPath || typeof assetPath !== 'string') {
    res.statusCode = 400;
    res.json({ error: 'No asset path provided.' });
    return;
  }

  if (platform !== 'ios' && platform !== 'android') {
    res.statusCode = 400;
    res.json({ error: 'No platform provided. Expected "ios" or "android".' });
    return;
  }

  if (!runtimeVersion || typeof runtimeVersion !== 'string') {
    res.statusCode = 400;
    res.json({ error: 'No runtimeVersion provided.' });
    return;
  }

  try {
    const updateBundlePath = await UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync(
      runtimeVersion as string
    );
    const zip = await ZipHelper.getZipFromStorage(updateBundlePath);

    const { metadataJson } = await UpdateHelper.getMetadataAsync({
      updateBundlePath,
      runtimeVersion: runtimeVersion as string,
    });

    const assetMetadata = metadataJson.fileMetadata[platform].assets.find(
      (asset: any) => asset.path === assetPath
    );
    const isLaunchAsset = metadataJson.fileMetadata[platform].bundle === assetPath;

    const asset = await ZipHelper.getFileFromZip(zip, assetPath as string);

    res.statusCode = 200;
    res.setHeader(
      'content-type',
      isLaunchAsset ? 'application/javascript' : nullthrows(mime.getType(assetMetadata.ext))
    );
    // Assets are content-addressed (the filename is a content hash), so the
    // bytes for a given URL never change. Marking them immutable lets both
    // CloudFront and the device cache them ~forever, which is what makes asset
    // delivery scale during an update blast.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.end(asset);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.json({ error });
  }
}
