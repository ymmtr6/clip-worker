/**
 * 認証は2系統（yt-tv と同じ構成）。
 * - 視聴者: Cloudflare Access がエッジで認証し、Worker でも Access の JWT を検証する。
 * - ボット: 発行済みのエージェントトークン（Bearer）。スコープで操作を絞る。
 */

export const AGENT_SCOPES = ["read", "clips:write", "clips:delete"] as const;
export type Scope = typeof AGENT_SCOPES[number];

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * mc_<id>_<secret> 形式。id で1行引いてから secret を照合するので全件走査しない。
 * プレフィックスは漏洩時に secret scanning で見つけやすくするため。
 */
export function generateAgentToken(): { id: string; secret: string; token: string } {
  const id = randomHex(6);
  const secret = randomHex(24);
  return { id, secret, token: `mc_${id}_${secret}` };
}

export function parseAgentToken(token: string): { id: string; secret: string } | null {
  const match = /^mc_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(token);
  return match ? { id: match[1], secret: match[2] } : null;
}

export function parseScopes(value: unknown): Scope[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return AGENT_SCOPES.filter((scope) => raw.includes(scope));
}

type JwtHeader = { kid?: string; alg?: string };
type AccessClaims = { aud?: string | string[]; exp?: number; iss?: string; email?: string };

let certCache: { team: string; fetchedAt: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;

async function accessKeys(team: string): Promise<(JsonWebKey & { kid?: string })[]> {
  if (certCache && certCache.team === team && Date.now() - certCache.fetchedAt < 3_600_000) return certCache.keys;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("access_certs_unavailable");
  const body = await response.json() as { keys?: (JsonWebKey & { kid?: string })[] };
  certCache = { team, fetchedAt: Date.now(), keys: body.keys ?? [] };
  return certCache.keys;
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

/**
 * Access の JWT を検証してメールアドレスを返す。
 * Access の設定ミスでパスが素通しになっても、ここで弾けるようにしている。
 */
export async function verifyAccessJwt(jwt: string, team: string, audience: string): Promise<string | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson<JwtHeader>(parts[0]);
    const claims = decodeJson<AccessClaims>(parts[1]);
    if (header.alg !== "RS256") return null;

    const jwk = (await accessKeys(team)).find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) return null;
    if (claims.iss !== `https://${team}`) return null;
    if (!claims.exp || claims.exp * 1_000 < Date.now()) return null;
    return claims.email ?? "unknown";
  } catch {
    return null;
  }
}
