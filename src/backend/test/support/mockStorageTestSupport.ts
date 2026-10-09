import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A filesystem test double also survives worker process restarts. No S3 HTTP.
const ownsDirectory = !process.env.MOCK_STORAGE_DIRECTORY;
process.env.MOCK_STORAGE_DIRECTORY ??= mkdtempSync(
  join(tmpdir(), 'da-moa-mock-storage-'),
);
process.env.MINIO_ENDPOINT ??= 'http://mock-minio.test';
process.env.MINIO_BUCKET ??= 'mock-receipts-test';
process.env.MINIO_ACCESS_KEY ??= 'mock-only';
process.env.MINIO_SECRET_KEY ??= 'mock-only';
const directory = process.env.MOCK_STORAGE_DIRECTORY;
if (ownsDirectory)
  process.once('exit', () =>
    rmSync(directory, { recursive: true, force: true }),
  );
const missing = () =>
  Object.assign(new Error('Mock object does not exist'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });

S3Client.prototype.send = async function (
  command:
    | PutObjectCommand
    | GetObjectCommand
    | DeleteObjectCommand
    | HeadObjectCommand,
  options?: { abortSignal?: AbortSignal },
) {
  options?.abortSignal?.throwIfAborted();
  const { Bucket, Key } = command.input;
  if (!Bucket || !Key)
    throw new Error('Mock storage requires a bucket and key');
  const path = join(
    directory,
    createHash('sha256').update(`${Bucket}:${Key}`).digest('hex'),
  );
  if (command instanceof PutObjectCommand) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, command.input.Body as Uint8Array);
    await writeFile(
      path + '.json',
      JSON.stringify({ ContentType: command.input.ContentType }),
    );
    return {};
  }
  if (command instanceof DeleteObjectCommand) {
    await Promise.all([
      rm(path, { force: true }),
      rm(path + '.json', { force: true }),
    ]);
    return {};
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
    throw error;
  }
  options?.abortSignal?.throwIfAborted();
  const metadata = JSON.parse(await readFile(path + '.json', 'utf8'));
  if (command instanceof HeadObjectCommand)
    return { ...metadata, ContentLength: bytes.length };
  if (command instanceof GetObjectCommand)
    return {
      ...metadata,
      Body: { transformToByteArray: async () => new Uint8Array(bytes) },
    };
  throw new Error('Unsupported mock storage command');
} as S3Client['send'];
