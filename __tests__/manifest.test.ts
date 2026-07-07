import AdmZip from 'adm-zip';
import { createMocks } from 'node-mocks-http';
import FormData from 'form-data';

import { ConfigHelper } from '../apiUtils/helpers/ConfigHelper';
import { UpdateHelper, NoUpdateAvailableError } from '../apiUtils/helpers/UpdateHelper';
import { ZipHelper } from '../apiUtils/helpers/ZipHelper';
import { HashHelper } from '../apiUtils/helpers/HashHelper';
import manifestEndpoint from '../pages/api/manifest';
import { DatabaseFactory } from '../apiUtils/database/DatabaseFactory';
import { DatabaseInterface, Release } from '../apiUtils/database/DatabaseInterface';

jest.mock('../apiUtils/helpers/UpdateHelper');
jest.mock('../apiUtils/helpers/ZipHelper');
jest.mock('../apiUtils/helpers/ConfigHelper');
jest.mock('../apiUtils/helpers/HashHelper');
jest.mock('../apiUtils/helpers/PrecomputedManifestHelper');
jest.mock('../apiUtils/database/DatabaseFactory');
jest.mock('form-data');

import { PrecomputedManifestHelper } from '../apiUtils/helpers/PrecomputedManifestHelper';

describe('Manifest API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no precomputed artifact, so the endpoint exercises the
    // zip-based fallback path these tests assert against.
    (PrecomputedManifestHelper.tryGet as jest.Mock).mockResolvedValue(null);
  });

  it('should return 405 for non-GET requests', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await manifestEndpoint(req, res);
    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toMatchSnapshot();
  });

  it('should return 400 for invalid platform', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'web',
        'expo-runtime-version': '1.0.0',
      },
    });
    await manifestEndpoint(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toMatchSnapshot();
  });

  it('should return 400 for missing runtime version', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
      },
    });
    await manifestEndpoint(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toMatchSnapshot();
  });

  it('should return NoUpdateAvailable when user is already running the latest release', async () => {
    // Mock database to return a release with matching updateId
    const mockRelease: Release = {
      id: 'release-id',
      runtimeVersion: '1.0.0',
      path: 'path/to/update.zip',
      timestamp: '2024-03-20T00:00:00Z',
      commitHash: 'abc123',
      commitMessage: 'Test commit',
      updateId: 'test-update-id',
    };

    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(mockRelease),
    } as unknown as DatabaseInterface;

    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    // Mock NoUpdateAvailable directive
    const mockNoUpdateDirective = { type: 'noUpdateAvailable' };
    (UpdateHelper.createNoUpdateAvailableDirectiveAsync as jest.Mock).mockResolvedValue(
      mockNoUpdateDirective
    );

    // Mock FormData
    const mockFormData = {
      append: jest.fn(),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
        'expo-current-update-id': 'test-update-id', // Same as the release updateId
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(UpdateHelper.createNoUpdateAvailableDirectiveAsync).toHaveBeenCalled();
    expect(mockFormData.append).toHaveBeenCalledWith(
      'directive',
      JSON.stringify(mockNoUpdateDirective),
      expect.any(Object)
    );
  });

  it('should handle normal update successfully', async () => {
    // Mock database to return a release with different updateId
    const mockRelease: Release = {
      id: 'release-id',
      runtimeVersion: '1.0.0',
      path: 'path/to/update.zip',
      timestamp: '2024-03-20T00:00:00Z',
      commitHash: 'abc123',
      commitMessage: 'Test commit',
      updateId: 'different-update-id',
    };

    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(mockRelease),
      getReleaseByPath: jest.fn().mockResolvedValue(mockRelease),
      createTracking: jest.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseInterface;

    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    const mockMetadata = {
      metadataJson: {
        fileMetadata: {
          ios: {
            assets: [{ path: 'test.png', ext: '.png' }],
            bundle: 'bundle.js',
          },
        },
      },
      createdAt: '2024-03-20T00:00:00Z',
      id: 'test-id',
    };

    // Mock UUID conversion
    const mockUUID = 'test-uuid';
    (HashHelper.convertSHA256HashToUUID as jest.Mock).mockReturnValue(mockUUID);

    // Mock UpdateHelper methods
    (UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync as jest.Mock).mockResolvedValue(
      'path/to/update'
    );
    (UpdateHelper.getMetadataAsync as jest.Mock).mockResolvedValue(mockMetadata);
    (UpdateHelper.getAssetMetadataAsync as jest.Mock).mockResolvedValue({
      hash: 'hash',
      key: 'key',
      fileExtension: '.ext',
      contentType: 'contentType',
      url: 'url',
    });

    // Mock ConfigHelper
    (ConfigHelper.getExpoConfigAsync as jest.Mock).mockResolvedValue({});

    // Mock ZipHelper
    const mockZip = {
      getEntry: jest.fn().mockReturnValue(null),
    };
    (ZipHelper.getZipFromStorage as jest.Mock).mockResolvedValue(mockZip as unknown as AdmZip);

    // Mock FormData
    const mockFormData = {
      append: jest.fn(),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
        'expo-current-update-id': 'current-update-id', // Different from the release updateId
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDatabase.createTracking).toHaveBeenCalled();
    expect(mockFormData.append).toHaveBeenCalledWith(
      'manifest',
      expect.any(String),
      expect.any(Object)
    );
  });

  it('should serve from precomputed manifest without touching the zip', async () => {
    const mockRelease: Release = {
      id: 'release-id',
      runtimeVersion: '1.0.0',
      path: 'path/to/update.zip',
      timestamp: '2024-03-20T00:00:00Z',
      commitHash: 'abc123',
      commitMessage: 'Test commit',
      updateId: 'different-update-id',
    };

    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(mockRelease),
      getReleaseByPath: jest.fn().mockResolvedValue(mockRelease),
      createTracking: jest.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseInterface;
    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    (UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync as jest.Mock).mockResolvedValue(
      'path/to/update'
    );

    // A precomputed artifact exists — the fast path should be used.
    (PrecomputedManifestHelper.tryGet as jest.Mock).mockResolvedValue({
      version: 1,
      createdAt: '2024-03-20T00:00:00Z',
      isRollback: false,
      platforms: {
        ios: {
          id: 'precomputed-update-id',
          assets: [
            {
              hash: 'asset-hash',
              key: 'asset-key',
              fileExtension: '.png',
              contentType: 'image/png',
              filePath: 'assets/test.png',
            },
          ],
          launchAsset: {
            hash: 'bundle-hash',
            key: 'bundle-key',
            fileExtension: '.bundle',
            contentType: 'application/javascript',
            filePath: 'bundle.js',
          },
          expoConfig: { name: 'test-app' },
        },
      },
    });

    let capturedManifest: any = null;
    const mockFormData = {
      append: jest.fn((field: string, value: string) => {
        if (field === 'manifest') capturedManifest = JSON.parse(value);
      }),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    process.env.HOST = 'https://cdn.example.com';

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
        'expo-current-update-id': 'current-update-id',
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    // Zip must NOT be downloaded, and per-asset hashing must NOT run.
    expect(ZipHelper.getZipFromStorage).not.toHaveBeenCalled();
    expect(UpdateHelper.getMetadataAsync).not.toHaveBeenCalled();
    expect(UpdateHelper.getAssetMetadataAsync).not.toHaveBeenCalled();
    // Manifest is built from precomputed data, with URLs from the current HOST.
    expect(capturedManifest.id).toBe('precomputed-update-id');
    expect(capturedManifest.assets[0].url).toBe(
      'https://cdn.example.com/api/assets?asset=assets/test.png&runtimeVersion=1.0.0&platform=ios'
    );
    expect(capturedManifest.launchAsset.url).toBe(
      'https://cdn.example.com/api/assets?asset=bundle.js&runtimeVersion=1.0.0&platform=ios'
    );
    expect(mockDatabase.createTracking).toHaveBeenCalled();
  });

  it('should return NoUpdateAvailable via precomputed path when update id matches', async () => {
    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(null),
      getReleaseByPath: jest.fn().mockResolvedValue(null),
      createTracking: jest.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseInterface;
    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    (UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync as jest.Mock).mockResolvedValue(
      'path/to/update'
    );

    (PrecomputedManifestHelper.tryGet as jest.Mock).mockResolvedValue({
      version: 1,
      createdAt: '2024-03-20T00:00:00Z',
      isRollback: false,
      platforms: {
        ios: {
          id: 'matching-update-id',
          assets: [],
          launchAsset: {
            hash: 'h',
            key: 'k',
            fileExtension: '.bundle',
            contentType: 'application/javascript',
            filePath: 'bundle.js',
          },
          expoConfig: {},
        },
      },
    });

    const mockFormData = {
      append: jest.fn(),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
        'expo-current-update-id': 'matching-update-id',
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(ZipHelper.getZipFromStorage).not.toHaveBeenCalled();
    // Tracking should NOT run when there's no new update to download.
    expect(mockDatabase.createTracking).not.toHaveBeenCalled();
  });

  it('should handle rollback update successfully', async () => {
    // Mock database
    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(null),
    } as unknown as DatabaseInterface;

    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    // Mock UpdateHelper methods
    (UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync as jest.Mock).mockResolvedValue(
      'path/to/update'
    );
    (UpdateHelper.createRollBackDirectiveAsync as jest.Mock).mockResolvedValue({
      type: 'rollBackToEmbedded',
      parameters: {
        commitTime: '2024-03-20T00:00:00Z',
      },
    });

    // Mock ZipHelper to indicate rollback
    const mockZip = {
      getEntry: jest.fn().mockReturnValue({ name: 'rollback' }), // Return non-null to indicate rollback
    };
    (ZipHelper.getZipFromStorage as jest.Mock).mockResolvedValue(mockZip as unknown as AdmZip);

    // Mock FormData
    const mockFormData = {
      append: jest.fn(),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
        'expo-current-update-id': 'current-id',
        'expo-embedded-update-id': 'embedded-id',
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(UpdateHelper.createRollBackDirectiveAsync).toHaveBeenCalled();
    expect(mockFormData.append).toHaveBeenCalledWith(
      'directive',
      expect.any(String),
      expect.any(Object)
    );
  });

  it('should return NoUpdateAvailable when current update matches latest', async () => {
    // Mock database
    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(null),
    } as unknown as DatabaseInterface;

    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    // Mock UpdateHelper methods
    (UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync as jest.Mock).mockResolvedValue(
      'path/to/update'
    );

    const mockMetadata = {
      metadataJson: { fileMetadata: { ios: {} } },
      createdAt: '2024-03-20T00:00:00Z',
      id: 'test-id',
    };
    (UpdateHelper.getMetadataAsync as jest.Mock).mockResolvedValue(mockMetadata);

    // Mock UUID conversion to match current update ID
    (HashHelper.convertSHA256HashToUUID as jest.Mock).mockReturnValue('current-update-id');

    // Mock NoUpdateAvailable directive
    const mockNoUpdateDirective = { type: 'noUpdateAvailable' };
    (UpdateHelper.createNoUpdateAvailableDirectiveAsync as jest.Mock).mockResolvedValue(
      mockNoUpdateDirective
    );

    // Mock ZipHelper
    const mockZip = {
      getEntry: jest.fn().mockReturnValue(null), // Not a rollback
    };
    (ZipHelper.getZipFromStorage as jest.Mock).mockResolvedValue(mockZip as unknown as AdmZip);

    // Mock FormData
    const mockFormData = {
      append: jest.fn(),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
        'expo-current-update-id': 'current-update-id', // Will match the converted hash
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(UpdateHelper.createNoUpdateAvailableDirectiveAsync).toHaveBeenCalled();
  });

  it('should handle NoUpdateAvailable error from UpdateHelper', async () => {
    // Mock database
    const mockDatabase = {
      getLatestReleaseRecordForRuntimeVersion: jest.fn().mockResolvedValue(null),
    } as unknown as DatabaseInterface;

    (DatabaseFactory.getDatabase as jest.Mock).mockReturnValue(mockDatabase);

    // Mock UpdateHelper to throw NoUpdateAvailableError
    (UpdateHelper.getLatestUpdateBundlePathForRuntimeVersionAsync as jest.Mock).mockRejectedValue(
      new NoUpdateAvailableError()
    );

    // Mock NoUpdateAvailable directive
    const mockNoUpdateDirective = { type: 'noUpdateAvailable' };
    (UpdateHelper.createNoUpdateAvailableDirectiveAsync as jest.Mock).mockResolvedValue(
      mockNoUpdateDirective
    );

    // Mock FormData
    const mockFormData = {
      append: jest.fn(),
      getBoundary: jest.fn().mockReturnValue('boundary'),
      getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    };
    (FormData as unknown as jest.Mock).mockImplementation(() => mockFormData);

    const { req, res } = createMocks({
      method: 'GET',
      headers: {
        'expo-platform': 'ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '1',
      },
    });

    await manifestEndpoint(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(UpdateHelper.createNoUpdateAvailableDirectiveAsync).toHaveBeenCalled();
  });
});
