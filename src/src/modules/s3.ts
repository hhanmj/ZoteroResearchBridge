// S3 SigV4 客户端（P3）：适配中国科技云数据胶囊
// 实测约束（见 docs/cloud-spike.md §7.2）：
//  - endpoint https://s3.cstcloud.cn，region us-east-1，Path-Style
//  - 网关按 AccessKey 绑定的"应用"校验 User-Agent：UA 必须包含应用名（如 S3Drive）

import { sha256Hex, hmacSha256, hex } from "./sha256";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  uaApp: string;
  minIntervalMs?: number; // 请求间最小间隔（网关限速适配）
}

export interface S3Response {
  status: number;
  etag: string | null;
  contentLength: number | null;
  retryAfter: string | null;
  bodyText: string;
  error?: string;
}

let _lastRequestAt = 0;
async function pace(minMs: number): Promise<void> {
  const wait = _lastRequestAt + minMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastRequestAt = Date.now();
}

function uriEncode(s: string, encodeSlash: boolean): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += "/";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function amzDates(d = new Date()): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { amzDate: iso.replace(/[-:]/g, ""), dateStamp: iso.slice(0, 10).replace(/-/g, "") };
}

function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmacSha256(key, data);
}

function strBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function canonicalPath(cfg: S3Config, key: string): string {
  const enc = uriEncode(key, false);
  return cfg.pathStyle ? `/${cfg.bucket}${enc ? "/" + enc : ""}` : `/${enc}`;
}

export function objectUrl(cfg: S3Config, key: string, query?: Record<string, string>): string {
  let url = cfg.endpoint.replace(/\/+$/, "") + canonicalPath(cfg, key);
  if (query && Object.keys(query).length) {
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k]!, true)}`)
      .join("&");
    url += "?" + qs;
  }
  return url;
}

export function sigv4Headers(
  cfg: S3Config,
  method: string,
  key: string,
  query: Record<string, string> | undefined,
  body: Uint8Array,
  contentType?: string,
  now: Date = new Date(),
): Record<string, string> {
  const host = new URL(cfg.endpoint).host;
  const { amzDate, dateStamp } = amzDates(now);
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (contentType) headers["content-type"] = contentType;
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((k) => `${k}:${headers[k]!.trim()}\n`).join("");
  const signedHeaders = signed.join(";");
  const canonicalQuery = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k]!, true)}`)
        .join("&")
    : "";
  const canonicalRequest = [
    method,
    canonicalPath(cfg, key),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(strBytes(canonicalRequest)),
  ].join("\n");
  let kDate = hmac(strBytes("AWS4" + cfg.secretAccessKey), strBytes(dateStamp));
  let kRegion = hmac(kDate, strBytes(cfg.region));
  let kService = hmac(kRegion, strBytes("s3"));
  let kSigning = hmac(kService, strBytes("aws4_request"));
  const signature = hex(hmac(kSigning, strBytes(stringToSign)));
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function zrequest(
  cfg: S3Config,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<S3Response> {
  await pace(cfg.minIntervalMs ?? 400);
  const opts: any = {
    headers: { ...headers },
    successCodes: false,
    responseType: "text",
    timeout: 60000,
  };
  // Zotero.HTTP.request 使用 options.body（options.data 会被静默丢弃 → 0 字节上传）
  if (body && body.length) opts.body = body;
  try {
    const xhr = (await Zotero.HTTP.request(method, url, opts)) as any;
    return {
      status: xhr.status,
      etag: xhr.getResponseHeader?.("etag") || null,
      contentLength: xhr.getResponseHeader?.("content-length")
        ? parseInt(xhr.getResponseHeader("content-length"), 10)
        : null,
      retryAfter: xhr.getResponseHeader?.("retry-after") || null,
      bodyText: typeof xhr.responseText === "string" ? xhr.responseText : "",
    };
  } catch (e: any) {
    const status = e?.status || e?.xhr?.status || 0;
    return {
      status, etag: null, contentLength: null, retryAfter: null, bodyText: "",
      error: String(e?.message || e),
    };
  }
}

function withUA(cfg: S3Config, headers: Record<string, string>): Record<string, string> {
  // UA 绑定是平台硬约束：必须包含 AccessKey 创建时所选应用名
  return { ...headers, "User-Agent": `${cfg.uaApp} ZoteroResearchBridge` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn: () => Promise<S3Response>, tries = 6): Promise<S3Response> {
  let last: S3Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.status >= 200 && r.status < 300) return r;
    last = r;
    if (r.status === 429) {
      // 网关限速：优先尊重 Retry-After，否则指数退避（5s 起步）
      const ra = r.retryAfter ? parseInt(r.retryAfter, 10) * 1000 : 0;
      await sleep(Math.max(ra, Math.min(5000 * 2 ** i, 120000)));
      continue;
    }
    if (r.status >= 500 || r.status === 0) {
      await sleep(1000 * (i + 1));
      continue;
    }
    return r; // 其余 4xx 不重试
  }
  return last!;
}

export async function putObject(
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
): Promise<S3Response> {
  const headers = sigv4Headers(cfg, "PUT", key, undefined, body, contentType);
  return withRetry(() =>
    zrequest(cfg, "PUT", objectUrl(cfg, key), withUA(cfg, headers), body),
  );
}

export async function headObject(cfg: S3Config, key: string): Promise<S3Response> {
  const headers = sigv4Headers(cfg, "HEAD", key, undefined, new Uint8Array(0));
  return withRetry(() => zrequest(cfg, "HEAD", objectUrl(cfg, key), withUA(cfg, headers)));
}

export async function listObjects(
  cfg: S3Config,
  prefix = "",
  maxKeys = 1000,
): Promise<S3Response> {
  const query: Record<string, string> = { "list-type": "2", "max-keys": String(maxKeys) };
  if (prefix) query["prefix"] = prefix;
  const headers = sigv4Headers(cfg, "GET", "", query, new Uint8Array(0));
  return withRetry(() => zrequest(cfg, "GET", objectUrl(cfg, "", query), withUA(cfg, headers)));
}

export async function ping(cfg: S3Config): Promise<{ ok: boolean; detail: string }> {
  const r = await listObjects(cfg, "", 1);
  if (r.status === 200) return { ok: true, detail: `ListObjectsV2 200，桶可达` };
  return {
    ok: false,
    detail: `HTTP ${r.status}${r.error ? "（" + r.error + "）" : ""}${r.bodyText ? " body=" + r.bodyText.slice(0, 120) : ""}`,
  };
}
