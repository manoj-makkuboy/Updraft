import { S3Client } from '@aws-sdk/client-s3';
import { S3IamStorage } from '../apiUtils/storage/S3IamStorage';

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

const MockedS3Client = S3Client as jest.MockedClass<typeof S3Client>;

describe('S3IamStorage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should throw if S3_BUCKET_NAME is not set', () => {
    delete process.env.S3_BUCKET_NAME;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;

    expect(() => new S3IamStorage()).toThrow('S3 bucket name not configured');
  });

  it('should create client with explicit credentials when access keys are provided', () => {
    process.env.S3_BUCKET_NAME = 'my-bucket';
    process.env.S3_ACCESS_KEY_ID = 'test-key';
    process.env.S3_SECRET_ACCESS_KEY = 'test-secret';
    process.env.S3_REGION = 'us-east-1';

    new S3IamStorage();

    expect(MockedS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        },
      })
    );
  });

  it('should create client without credentials when access keys are absent', () => {
    process.env.S3_BUCKET_NAME = 'my-bucket';
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;

    new S3IamStorage();

    const callArgs = MockedS3Client.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('credentials');
  });

  it('should default region to auto when S3_REGION is not set', () => {
    process.env.S3_BUCKET_NAME = 'my-bucket';
    delete process.env.S3_REGION;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;

    new S3IamStorage();

    expect(MockedS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'auto' })
    );
  });

  it('should pass S3_ENDPOINT when set', () => {
    process.env.S3_BUCKET_NAME = 'my-bucket';
    process.env.S3_ENDPOINT = 'https://custom-endpoint.example.com';
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;

    new S3IamStorage();

    expect(MockedS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://custom-endpoint.example.com',
      })
    );
  });

  it('should not include credentials when only one key is provided', () => {
    process.env.S3_BUCKET_NAME = 'my-bucket';
    process.env.S3_ACCESS_KEY_ID = 'test-key';
    delete process.env.S3_SECRET_ACCESS_KEY;

    new S3IamStorage();

    const callArgs = MockedS3Client.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('credentials');
  });

  describe('methods', () => {
    let storage: S3IamStorage;
    let mockSend: jest.Mock;

    beforeEach(() => {
      process.env.S3_BUCKET_NAME = 'my-bucket';
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;

      storage = new S3IamStorage();
      mockSend = (MockedS3Client.mock.results[0].value as any).send;
    });

    it('uploadFile should send PutObjectCommand and return path', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await storage.uploadFile('path/to/file.bin', Buffer.from('data'));

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.constructor.name).toBe('PutObjectCommand');
      expect(result).toBe('path/to/file.bin');
    });

    it('downloadFile should return buffer from response body', async () => {
      const bodyBytes = new Uint8Array([1, 2, 3]);
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(bodyBytes) },
      });

      const result = await storage.downloadFile('path/to/file.bin');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(Buffer.from(bodyBytes));
    });

    it('downloadFile should throw when body is empty', async () => {
      mockSend.mockResolvedValueOnce({ Body: { transformToByteArray: () => Promise.resolve(undefined) } });

      await expect(storage.downloadFile('path/to/file.bin')).rejects.toThrow(
        'No body found in response'
      );
    });

    it('listFiles should return mapped file entries', async () => {
      const now = new Date('2025-01-01T00:00:00Z');
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: 'dir/file.json', LastModified: now, Size: 42 },
        ],
      });

      const result = await storage.listFiles('dir');

      expect(result).toEqual([
        {
          name: 'file.json',
          updated_at: now.toISOString(),
          created_at: now.toISOString(),
          metadata: { size: 42, mimetype: 'application/json' },
        },
      ]);
    });

    it('listDirectories should return stripped prefixes', async () => {
      mockSend.mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'root/subdir/' }],
      });

      const result = await storage.listDirectories('root/');

      expect(result).toEqual(['subdir']);
    });

    it('copyFile should send CopyObjectCommand', async () => {
      mockSend.mockResolvedValueOnce({});

      await storage.copyFile('source/path', 'dest/path');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.constructor.name).toBe('CopyObjectCommand');
    });
  });
});
