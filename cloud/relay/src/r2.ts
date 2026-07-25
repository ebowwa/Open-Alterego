import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { R2Config } from "./config";

export interface Presigner {
  presignPut(key: string, contentType: string, ttl: number): Promise<string>;
  presignGet(key: string, ttl: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

/** R2 is S3-compatible. Use virtual-host style via the account endpoint:
 *  https://<account_id>.r2.cloudflarestorage.com , region "auto". */
export function makeAwsPresigner(cfg: R2Config): Presigner {
  const clientOpts: S3ClientConfig = {
    region: cfg.region || "auto",
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
  if (cfg.endpoint) clientOpts.endpoint = cfg.endpoint;

  const client = new S3Client(clientOpts);

  return {
    async presignPut(key, contentType, ttl) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }),
        { expiresIn: ttl },
      );
    },
    async presignGet(key, ttl) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        expiresIn: ttl,
      });
    },
    async deleteObject(key) {
      // Best-effort: a 404 (already gone) is not an error for delete.
      try {
        await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
      } catch {
        /* swallow */
      }
    },
  };
}
