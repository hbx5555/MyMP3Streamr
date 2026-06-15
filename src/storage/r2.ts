import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

let cachedClient: S3Client | null = null;

function getR2Config() {
  if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET_NAME) {
    throw new Error('Missing R2 configuration');
  }
  return config;
}

export function getR2Client() {
  if (!cachedClient) {
    const r2Config = getR2Config();
    cachedClient = new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.R2_ACCESS_KEY_ID,
        secretAccessKey: r2Config.R2_SECRET_ACCESS_KEY
      }
    });
  }

  return cachedClient;
}

export async function putR2Object(key: string, body: Buffer | Uint8Array | string, contentType?: string) {
  const r2 = getR2Client();
  await r2.send(new PutObjectCommand({
    Bucket: getR2Config().R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
}

export async function headR2Object(key: string) {
  const r2 = getR2Client();
  return r2.send(new HeadObjectCommand({
    Bucket: getR2Config().R2_BUCKET_NAME,
    Key: key
  }));
}

export async function getR2Object(key: string, range?: string) {
  const r2 = getR2Client();
  return r2.send(new GetObjectCommand({
    Bucket: getR2Config().R2_BUCKET_NAME,
    Key: key,
    Range: range
  }));
}

export async function presignR2Get(key: string, ttlSeconds: number) {
  const r2 = getR2Client();
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: getR2Config().R2_BUCKET_NAME,
      Key: key
    }),
    { expiresIn: ttlSeconds }
  );
}

export function r2PublicUrl(key: string) {
  if (!config.R2_PUBLIC_BASE_URL) return null;
  return `${config.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
}
