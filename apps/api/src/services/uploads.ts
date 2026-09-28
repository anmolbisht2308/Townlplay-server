import { createHash } from "node:crypto";
import type { UploadSignature } from "@townplay/shared";

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Parses `cloudinary://<api_key>:<api_secret>@<cloud_name>`. */
export function parseCloudinaryUrl(url: string): CloudinaryConfig {
  const u = new URL(url);
  if (u.protocol !== "cloudinary:" || !u.username || !u.password || !u.hostname) {
    throw new Error("CLOUDINARY_URL must look like cloudinary://key:secret@cloud");
  }
  return {
    cloudName: u.hostname,
    apiKey: decodeURIComponent(u.username),
    apiSecret: decodeURIComponent(u.password),
  };
}

/**
 * Signs a direct browser → Cloudinary upload (no SDK: the signature is sha1 of the sorted
 * params + secret). The browser posts the file with these fields to `uploadUrl`.
 */
export function signUpload(
  config: CloudinaryConfig,
  folder: string,
  now: Date = new Date(),
): UploadSignature {
  const timestamp = Math.floor(now.getTime() / 1000);
  const toSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = createHash("sha1").update(`${toSign}${config.apiSecret}`).digest("hex");
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    apiKey: config.apiKey,
    timestamp,
    signature,
    folder,
  };
}

/** Photos must come from our Cloudinary account (when configured). */
export function isOwnPhotoUrl(config: CloudinaryConfig | undefined, url: string): boolean {
  if (!config) return url.startsWith("https://");
  return url.startsWith(`https://res.cloudinary.com/${config.cloudName}/`);
}
