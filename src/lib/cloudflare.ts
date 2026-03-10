/**
 * Cloudflare R2 Client — The Fiber Commons
 *
 * Handles R2 bucket operations (upload, get, delete) for the
 * fiber-commons-images bucket. Event images only — no photo
 * permissions, KV, or social features.
 *
 * Uses the S3-compatible API with AWS Signature V4.
 */

import { config } from '../config.js';

// =============================================================================
// R2 CLIENT
// =============================================================================

/**
 * Get R2 API endpoint
 */
function getR2Endpoint(): string {
  return `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
}

/**
 * Generate AWS Signature V4 authorization header for R2.
 * R2 uses S3-compatible auth.
 */
async function signR2Request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Uint8Array
): Promise<Record<string, string>> {
  const accessKeyId = config.r2.accessKeyId;
  const secretAccessKey = config.r2.secretAccessKey;
  const region = 'auto';
  const service = 's3';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // Create canonical request
  const canonicalUri = path;
  const canonicalQueryString = '';

  const signedHeaders = Object.keys(headers)
    .map(k => k.toLowerCase())
    .sort()
    .join(';');

  const canonicalHeaders = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
    .sort()
    .join('\n') + '\n';

  // Hash the payload
  const payloadHash = await sha256Hex(body || new Uint8Array(0));

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join('\n');

  // Calculate signature
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = await hmacSha256Hex(kSigning, stringToSign);

  // Build authorization header
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...headers,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization': authorization,
  };
}

/**
 * Upload a file to R2.
 */
export async function uploadToR2(
  key: string,
  data: Uint8Array,
  contentType: string
): Promise<{ success: boolean; error?: string }> {
  if (!config.r2.enabled) {
    console.warn('[R2] Cloudflare R2 credentials not configured, skipping upload');
    return { success: false, error: 'R2 not configured' };
  }

  try {
    const endpoint = getR2Endpoint();
    const bucket = config.r2.bucketName;
    const path = `/${bucket}/${key}`;
    const host = `${config.r2.accountId}.r2.cloudflarestorage.com`;

    const headers: Record<string, string> = {
      'Host': host,
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    };

    const signedHeaders = await signR2Request('PUT', path, headers, data);

    const response = await fetch(`${endpoint}${path}`, {
      method: 'PUT',
      headers: signedHeaders,
      body: data,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[R2] Upload failed:', response.status, text);
      return { success: false, error: `R2 upload failed: ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    console.error('[R2] Upload error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'R2 upload failed',
    };
  }
}

/**
 * Get a file from R2.
 */
export async function getFromR2(key: string): Promise<{ data: Uint8Array | null; contentType: string | null; error?: string }> {
  if (!config.r2.enabled) {
    return { data: null, contentType: null, error: 'R2 not configured' };
  }

  try {
    const endpoint = getR2Endpoint();
    const bucket = config.r2.bucketName;
    const path = `/${bucket}/${key}`;
    const host = `${config.r2.accountId}.r2.cloudflarestorage.com`;

    const headers: Record<string, string> = {
      'Host': host,
    };

    const signedHeaders = await signR2Request('GET', path, headers);

    const response = await fetch(`${endpoint}${path}`, {
      method: 'GET',
      headers: signedHeaders,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { data: null, contentType: null };
      }
      const text = await response.text();
      console.error('[R2] Get failed:', response.status, text);
      return { data: null, contentType: null, error: `R2 get failed: ${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type');

    return {
      data: new Uint8Array(arrayBuffer),
      contentType,
    };
  } catch (error) {
    console.error('[R2] Get error:', error);
    return {
      data: null,
      contentType: null,
      error: error instanceof Error ? error.message : 'R2 get failed',
    };
  }
}

/**
 * Delete a file from R2.
 */
export async function deleteFromR2(key: string): Promise<{ success: boolean; error?: string }> {
  if (!config.r2.enabled) {
    return { success: false, error: 'R2 not configured' };
  }

  try {
    const endpoint = getR2Endpoint();
    const bucket = config.r2.bucketName;
    const path = `/${bucket}/${key}`;
    const host = `${config.r2.accountId}.r2.cloudflarestorage.com`;

    const headers: Record<string, string> = {
      'Host': host,
    };

    const signedHeaders = await signR2Request('DELETE', path, headers);

    const response = await fetch(`${endpoint}${path}`, {
      method: 'DELETE',
      headers: signedHeaders,
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      console.error('[R2] Delete failed:', response.status, text);
      return { success: false, error: `R2 delete failed: ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    console.error('[R2] Delete error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'R2 delete failed',
    };
  }
}

// =============================================================================
// CRYPTO HELPERS (for AWS Signature V4)
// =============================================================================

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

async function hmacSha256Hex(key: Uint8Array, data: string): Promise<string> {
  const hash = await hmacSha256(key, data);
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
