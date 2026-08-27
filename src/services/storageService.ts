import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';

const isConfigured = !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (isConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true
  });
} else {
  console.warn('WARNING: Cloudinary storage is not configured — file uploads will return 503 until CLOUDINARY_* env vars are set.');
}

export const isStorageConfigured = (): boolean => isConfigured;

export type StorageResourceType = 'image' | 'raw';

// Uploads a buffer to Cloudinary under `publicId` and returns its public
// delivery URL. Images go through Cloudinary's `image` pipeline (gets CDN
// delivery/optimization); non-image files (PDFs) use `raw` so they're
// stored and served as-is rather than being treated as convertible media —
// for `raw`, Cloudinary does NOT auto-append a file extension to the
// delivery URL, so `publicId` should already include one for those.
export const uploadToStorage = async (
  publicId: string,
  buffer: Buffer,
  contentType: string,
  resourceType: StorageResourceType = 'image'
): Promise<string> => {
  if (!isConfigured) {
    throw new Error('Cloudinary storage is not configured');
  }

  const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    public_id: publicId,
    resource_type: resourceType,
    overwrite: false
  });

  return result.secure_url;
};
