/**
 * Minimal S3 client for the sync engine, built on Node's global fetch and
 * WebCrypto-free `node:crypto` HMAC helpers. It speaks the subset the engine
 * needs: ListObjectsV2, HEAD/GET Object, PUT Object with conditional headers,
 * and DELETE Object.
 *
 * Path-style addressing is the default because self-hosted endpoints are often
 * reached by IP and have no wildcard DNS; virtual-host style is available for
 * AWS-like deployments.
 */
import crypto from 'node:crypto'
import { WebdavError } from './webdav.js'
import { errorMessage } from './util.js'

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex')
const MAX_ERROR_BYTES = 8192
const MAX_PAGES = 10_000

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest()
}

/** AWS SigV4 requires RFC 3986 encoding, stricter than encodeURIComponent. */
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
}

function tag(xml, name) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${name}>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml)
  return match ? decodeXml(match[1]).trim() : undefined
}

function amzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function parseS3Error(body) {
  const code = tag(body, 'Code')
  const message = tag(body, 'Message')
  return { code, message }
}

export class S3Client {
  /**
   * @param {object} options
   * @param {string} options.endpoint e.g. https://114.66.54.114:28080
   * @param {string} options.bucket
   * @param {string} options.accessKeyId
   * @param {string} options.secretAccessKey
   * @param {string} [options.region]
   * @param {string} [options.sessionToken]
   * @param {boolean} [options.pathStyle]
   * @param {number} [options.timeoutMs]
   */
  constructor(options) {
    const endpoint = String(options.endpoint ?? '').trim()
    if (!/^https?:\/\//i.test(endpoint)) throw new WebdavError('S3 endpoint must start with http:// or https://')
    if (!options.bucket) throw new WebdavError('S3 bucket is required')
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.bucket = options.bucket
    this.accessKeyId = options.accessKeyId ?? ''
    this.secretAccessKey = options.secretAccessKey ?? ''
    this.sessionToken = options.sessionToken ?? ''
    this.region = options.region || 'us-east-1'
    this.pathStyle = options.pathStyle !== false
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.createdCollections = new Set()
  }

  /** Build the request URL plus its sorted canonical query pairs. */
  #url(key, query) {
    const base = new URL(this.endpoint)
    const basePath = base.pathname.replace(/\/+$/, '')
    const encodedKey = String(key ?? '')
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter((segment) => segment.length > 0)
      .map(uriEncode)
      .join('/')
    const host = this.pathStyle ? base.host : `${this.bucket}.${base.host}`
    const path = this.pathStyle
      ? `${basePath}/${uriEncode(this.bucket)}${encodedKey ? `/${encodedKey}` : ''}`
      : `${basePath}${encodedKey ? `/${encodedKey}` : ''}`
    const pairs = (query ?? [])
      .map(([name, value]) => [String(name), String(value)])
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    const canonicalQuery = pairs
      .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
      .join('&')
    const url = new URL(`${base.protocol}//${host}${path || '/'}`)
    if (canonicalQuery) url.search = canonicalQuery
    return { url, canonicalQuery, encodedPath: url.pathname }
  }

  #signature(method, url, canonicalQuery, headers, payloadHash, timestamp) {
    const date = timestamp.slice(0, 8)
    const names = Object.keys(headers).map((name) => name.toLowerCase()).sort()
    const canonicalHeaders = names
      .map((name) => `${name}:${String(headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name)]).trim()}`)
      .join('\n')
    const signedHeaders = names.join(';')
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      `${canonicalHeaders}\n`,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${date}/${this.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n')
    const kDate = hmac(`AWS4${this.secretAccessKey}`, date)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, 's3')
    const kSigning = hmac(kService, 'aws4_request')
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }

  /** One signed request with a single transport retry. */
  async #fetch(method, key, query, body, extraHeaders, signal) {
    const { url, canonicalQuery } = this.#url(key, query)
    const timestamp = amzDate()
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body)
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      ...(this.sessionToken ? { 'x-amz-security-token': this.sessionToken } : {}),
      ...(extraHeaders ?? {}),
    }
    const authorization = this.#signature(method, url, canonicalQuery, headers, payloadHash, timestamp)

    const signals = [AbortSignal.timeout(this.timeoutMs)]
    if (signal) signals.push(signal)
    const composite = AbortSignal.any(signals)

    let lastError
    const delays = [400, 1200]
    for (let attempt = 0; attempt < delays.length + 1; attempt += 1) {
      try {
        return await fetch(url, {
          method,
          headers: { ...headers, authorization },
          body,
          signal: composite,
        })
      } catch (error) {
        lastError = error
        if (signal?.aborted) break
        if (attempt < delays.length) await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      }
    }
    const cause = []
    let current = lastError
    for (let depth = 0; current && depth < 4; depth += 1) {
      cause.push(current.code ? `${current.code} (${current.message})` : current.message)
      current = current.cause
    }
    throw new WebdavError(
      `${method} s3://${this.bucket}/${String(key ?? '')} failed: ${cause.join(' ← ') || 'network error'}`,
      { method, path: key },
    )
  }

  async #error(method, key, response) {
    let body = ''
    try {
      body = (await response.text()).slice(0, MAX_ERROR_BYTES)
    } catch {
      body = ''
    }
    const parsed = parseS3Error(body)
    const detail = parsed.code || parsed.message
      ? `${parsed.code ?? 'Error'}${parsed.message ? `: ${parsed.message}` : ''}`
      : body.replace(/\s+/g, ' ').trim().slice(0, 300)
    return new WebdavError(
      `S3 ${method} ${String(key ?? '') || '/'} returned HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      { status: response.status, method, path: key },
    )
  }

  /** List every object below a prefix (flat keys, paginated). */
  async walk(prefix, options = {}) {
    const clean = String(prefix ?? '').replace(/^\/+|\/+$/g, '')
    const rootPrefix = clean ? `${clean}/` : ''
    const objects = new Map()
    let token
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = [['list-type', '2'], ['prefix', rootPrefix], ['max-keys', '1000']]
      if (token) query.push(['continuation-token', token])
      const response = await this.#fetch('GET', '', query, undefined, {}, options.signal)
      if (!response.ok) throw await this.#error('GET', clean, response)
      const xml = await response.text()
      const blocks = xml.match(/<(?:[\w.-]+:)?Contents>[\s\S]*?<\/(?:[\w.-]+:)?Contents>/g) ?? []
      for (const block of blocks) {
        const key = tag(block, 'Key')
        if (!key || key === rootPrefix || key.endsWith('/')) continue
        const rel = rootPrefix && key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : key
        const size = Number(tag(block, 'Size'))
        const modified = Date.parse(tag(block, 'LastModified') ?? '')
        objects.set(rel, {
          rel,
          etag: tag(block, 'ETag'),
          size: Number.isFinite(size) ? size : undefined,
          mtimeMs: Number.isFinite(modified) ? modified : undefined,
        })
      }
      const truncated = tag(xml, 'IsTruncated') === 'true'
      token = tag(xml, 'NextContinuationToken')
      if (!truncated || !token) break
    }
    return objects
  }

  /** HEAD one object; undefined when it does not exist. */
  async stat(key, signal) {
    const response = await this.#fetch('HEAD', key, [], undefined, {}, signal)
    if (response.status === 404) return undefined
    if (!response.ok) throw await this.#error('HEAD', key, response)
    const length = response.headers.get('content-length')
    const modified = Date.parse(response.headers.get('last-modified') ?? '')
    return {
      rel: String(key ?? ''),
      etag: response.headers.get('etag') ?? undefined,
      size: length !== null ? Number(length) : undefined,
      mtimeMs: Number.isFinite(modified) ? modified : undefined,
    }
  }

  async get(key, signal) {
    const response = await this.#fetch('GET', key, [], undefined, {}, signal)
    if (response.status === 404) {
      throw new WebdavError(`S3 GET ${key} returned HTTP 404`, { status: 404, method: 'GET', path: key })
    }
    if (!response.ok) throw await this.#error('GET', key, response)
    const body = Buffer.from(await response.arrayBuffer())
    const modified = Date.parse(response.headers.get('last-modified') ?? '')
    return {
      body,
      etag: response.headers.get('etag') ?? undefined,
      mtimeMs: Number.isFinite(modified) ? modified : undefined,
    }
  }

  async put(key, body, options = {}) {
    const headers = { 'content-type': 'application/octet-stream' }
    if (options.ifMatch) headers['if-match'] = options.ifMatch
    if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch
    const response = await this.#fetch('PUT', key, [], body, headers, options.signal)
    if (!response.ok) throw await this.#error('PUT', key, response)
    return { etag: response.headers.get('etag') ?? undefined, status: response.status }
  }

  async delete(key, options = {}) {
    const response = await this.#fetch('DELETE', key, [], undefined, {}, options.signal)
    // A missing object is already the desired state.
    if (response.status === 404 || response.status === 200 || response.status === 204) return
    throw await this.#error('DELETE', key, response)
  }

  /** Object stores have no collections; the engine calls this before uploads. */
  async ensureCollection() {}

  /** Exposed for diagnostics and tests. */
  async bucketExists(signal) {
    const response = await this.#fetch('HEAD', '', [], undefined, {}, signal)
    if (response.status === 404) return false
    if (!response.ok) throw await this.#error('HEAD', '', response)
    return true
  }
}

export { EMPTY_SHA256, uriEncode }
