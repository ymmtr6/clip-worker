import { AwsClient } from "aws4fetch";

/**
 * Wasabi（S3 互換）への操作。テストでは同じ形のメモリ実装に差し替える。
 * バケットは private のまま、読み書きはすべて署名付き URL か Worker 経由で行う。
 */
export interface Storage {
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  presignPut(key: string, contentType: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** 長さの分かっているストリームをそのまま置く。URL 取り込みで使う */
  put(key: string, body: ReadableStream, length: number, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type WasabiEnv = {
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  WASABI_ACCESS_KEY: string;
  WASABI_SECRET_KEY: string;
};

export function wasabiStorage(env: WasabiEnv): Storage {
  const client = new AwsClient({
    accessKeyId: env.WASABI_ACCESS_KEY,
    secretAccessKey: env.WASABI_SECRET_KEY,
    region: env.S3_REGION,
    service: "s3",
  });
  const objectUrl = (key: string) =>
    `https://${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    async presignGet(key, ttlSeconds) {
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
      const signed = await client.sign(url.toString(), { method: "GET", aws: { signQuery: true } });
      return signed.url;
    },

    // Content-Type を署名に含めるので、PUT するときは同じ値を送る必要がある
    async presignPut(key, contentType, ttlSeconds) {
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
      const signed = await client.sign(url.toString(), {
        method: "PUT",
        headers: { "Content-Type": contentType },
        aws: { signQuery: true },
      });
      return signed.url;
    },

    async head(key) {
      const response = await client.fetch(objectUrl(key), { method: "HEAD" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`S3 head failed (${response.status})`);
      return {
        size: Number(response.headers.get("content-length") ?? 0),
        contentType: response.headers.get("content-type"),
      };
    },

    async put(key, body, length, contentType) {
      // S3 の PUT は Content-Length が必須。FixedLengthStream で長さを伝えたままストリームで流す
      const { readable, writable } = new FixedLengthStream(length);
      const piping = body.pipeTo(writable);
      const response = await client.fetch(objectUrl(key), {
        method: "PUT",
        body: readable,
        headers: { "Content-Type": contentType, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" },
      });
      await piping;
      if (!response.ok) throw new Error(`S3 put failed (${response.status})`);
    },

    async delete(key) {
      const response = await client.fetch(objectUrl(key), { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`S3 delete failed (${response.status})`);
    },
  };
}
