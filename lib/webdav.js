/**
 * Minimal WebDAV client built on the global `fetch`. It covers the methods this
 * plugin needs — PROPFIND, GET, PUT, DELETE, MKCOL — with Basic auth, timeouts,
 * one retry after a transport failure, and XML multistatus parsing.
 *
 * No external dependency is used: a DSH bundle installed from a local directory
 * cannot resolve packages from the DSH installation, so the client must be
 * self-contained.
 */

export class WebdavError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'WebdavError'
    this.status = options.status
    this.method = options.method
    this.path = options.path
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXml(value) {
  if (!value) return ''
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return XML_ENTITIES[entity] ?? match
  })
}

function firstTag(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match ? decodeXml(match[1]).trim() : undefined
}

/** Remove namespace prefixes so a parser does not depend on a server's choice. */
function stripNamespaces(xml) {
  return xml.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1').replace(/\sxmlns(?::[A-Za-z_][\w.-]*)?="[^"]*"/g, '')
}

/** Flatten an undici fetch failure and its cause chain into one readable line. */
function describeFetchError(error) {
  if (!error) return 'network error'
  const parts = []
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    const label = current.code ? `${current.code} (${current.message})` : current.message
    if (label && !parts.includes(label)) parts.push(label)
    current = current.cause
  }
  return parts.join(' ← ') || 'network error'
}

function parseDate(value) {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

export class WebdavClient {
  /**
   * @param {object} options
   * @param {string} options.url Absolute WebDAV collection URL.
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor(options) {
    const url = String(options.url ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(url)) throw new WebdavError('WebDAV url must start with http:// or https://')
    this.baseUrl = url
    this.username = options.username ?? ''
    this.password = options.password ?? ''
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new WebdavError('global fetch is unavailable in this Node runtime')
    this.authorization = this.username || this.password
      ? `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
      : undefined
    this.basePath = decodeURIComponent(new URL(this.baseUrl).pathname).replace(/\/+$/, '')
    this.createdCollections = new Set()
  }

  /** Absolute URL for a POSIX relative path below the base collection. */
  urlFor(rel) {
    const clean = String(rel ?? '').replace(/^\/+|\/+$/g, '')
    if (!clean) return this.baseUrl
    const encoded = clean.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `${this.baseUrl}/${encoded}`
  }

  async request(method, rel, options = {}) {
    const headers = { ...(options.headers ?? {}) }
    if (this.authorization) headers.Authorization = this.authorization
    if (options.depth !== undefined) headers.Depth = String(options.depth)
    if (options.ifMatch) headers['If-Match'] = options.ifMatch
    if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch
    if (options.contentType) headers['Content-Type'] = options.contentType

    const signals = []
    if (options.signal) signals.push(options.signal)
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signals.push(AbortSignal.timeout(this.timeoutMs))
    }
    const signal = signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals)

    let lastError
    const delays = [400, 1200]
    for (let attempt = 0; attempt < delays.length + 1; attempt += 1) {
      try {
        return await this.fetchImpl(this.urlFor(rel), {
          method,
          headers,
          body: options.body,
          signal,
          redirect: 'follow',
        })
      } catch (error) {
        lastError = error
        if (options.signal && options.signal.aborted) break
        if (attempt < delays.length) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
        }
      }
    }
    throw new WebdavError(`${method} ${rel || '/'} failed: ${describeFetchError(lastError)}`, {
      method,
      path: rel,
    })
  }

  async #expect(method, rel, response, accepted) {
    if (accepted.includes(response.status)) return response
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      detail = ''
    }
    const compact = detail.replace(/\s+/g, ' ').trim()
    let suffix = compact ? ` — ${compact}` : ''
    if (/<Error>[\s\S]*<Code>/.test(detail)) {
      suffix += ' — the server answered with an S3-style error; this URL is probably an S3 endpoint, not WebDAV'
    }
    throw new WebdavError(`${method} ${rel || '/'} returned HTTP ${response.status}${suffix}`, {
      status: response.status,
      method,
      path: rel,
    })
  }

  /**
   * PROPFIND one collection. Returns the collection itself plus direct children
   * as `{ rel, isDir, etag, size, mtimeMs }`; a missing collection is empty.
   */
  async propfind(rel, depth = 1, signal) {
    const response = await this.request('PROPFIND', rel, {
      depth,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      signal,
    })
    if (response.status === 404 || response.status === 410) return []
    await this.#expect('PROPFIND', rel, response, [207])
    const xml = await response.text()
    return this.#parseMultistatus(xml)
  }

  #parseMultistatus(xml) {
    const cleaned = stripNamespaces(xml)
    const entries = []
    const responsePattern = /<response>([\s\S]*?)<\/response>/g
    let match
    while ((match = responsePattern.exec(cleaned)) !== null) {
      const block = match[1]
      const href = firstTag(block, 'href')
      if (!href) continue
      let pathname
      try {
        pathname = decodeURIComponent(new URL(href, this.baseUrl).pathname)
      } catch {
        continue
      }
      let rel = pathname
      if (this.basePath && rel.startsWith(this.basePath)) rel = rel.slice(this.basePath.length)
      rel = rel.replace(/^\/+|\/+$/g, '')
      const isDir = /<collection\s*\/>/.test(block) || (rel === '' && pathname.endsWith('/'))
      const etag = firstTag(block, 'getetag')
      const lengthText = firstTag(block, 'getcontentlength')
      const length = lengthText !== undefined && lengthText !== '' ? Number(lengthText) : undefined
      entries.push({
        rel,
        isDir,
        etag,
        size: Number.isFinite(length) ? length : undefined,
        mtimeMs: parseDate(firstTag(block, 'getlastmodified')),
      })
    }
    return entries
  }

  /** Recursively list every non-collection entry below `rootRel`. */
  async walk(rootRel, options = {}) {
    const maxDepth = options.maxDepth ?? 16
    const root = String(rootRel ?? '').replace(/^\/+|\/+$/g, '')
    const result = new Map()
    const visit = async (absoluteRel, relativePrefix, depth) => {
      if (depth > maxDepth) return
      let entries
      try {
        entries = await this.propfind(absoluteRel, 1, options.signal)
      } catch (error) {
        if (error?.status === 404) return
        throw error
      }
      for (const entry of entries) {
        if (entry.rel === absoluteRel) continue
        const childName = entry.rel.startsWith(`${absoluteRel}/`)
          ? entry.rel.slice(absoluteRel.length + 1)
          : entry.rel
        const childRel = relativePrefix ? `${relativePrefix}/${childName}` : childName
        if (entry.isDir) {
          await visit(entry.rel, childRel, depth + 1)
        } else {
          result.set(childRel, { ...entry, rel: childRel })
        }
      }
    }
    await visit(root, '', 0)
    return result
  }

  /** Stat one file or collection; undefined when absent. */
  async stat(rel, signal) {
    const entries = await this.propfind(rel, 0, signal)
    return entries.find((entry) => entry.rel === String(rel ?? '').replace(/^\/+|\/+$/g, ''))
  }

  /** Download a file. */
  async get(rel, signal) {
    const response = await this.request('GET', rel, { signal })
    if (response.status === 404) {
      const error = new WebdavError(`GET ${rel} returned HTTP 404`, { status: 404, method: 'GET', path: rel })
      throw error
    }
    await this.#expect('GET', rel, response, [200, 206])
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      body: buffer,
      etag: response.headers.get('etag') ?? undefined,
      mtimeMs: parseDate(response.headers.get('last-modified')),
    }
  }

  /**
   * Upload a file. `ifMatch` makes the write conditional on the remote version;
   * `ifNoneMatch: '*'` refuses to overwrite anything that already exists.
   */
  async put(rel, body, options = {}) {
    const response = await this.request('PUT', rel, {
      body,
      contentType: 'application/octet-stream',
      ifMatch: options.ifMatch,
      ifNoneMatch: options.ifNoneMatch,
      signal: options.signal,
    })
    await this.#expect('PUT', rel, response, [200, 201, 204])
    return {
      etag: response.headers.get('etag') ?? undefined,
      status: response.status,
    }
  }

  /** Delete a file or collection; a missing target is already deleted. */
  async delete(rel, options = {}) {
    const response = await this.request('DELETE', rel, { signal: options.signal })
    await this.#expect('DELETE', rel, response, [200, 202, 204, 404, 410])
  }

  /** Create one collection; an existing collection is accepted. */
  async mkcol(rel, signal) {
    const response = await this.request('MKCOL', rel, { signal })
    await this.#expect('MKCOL', rel, response, [200, 201, 204, 405])
  }

  /** Create a collection and every missing parent below the base. */
  async ensureCollection(rel, signal) {
    const clean = String(rel ?? '').replace(/^\/+|\/+$/g, '')
    if (!clean) return
    if (this.createdCollections.has(clean)) return
    const segments = clean.split('/')
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      if (this.createdCollections.has(current)) continue
      await this.mkcol(current, signal)
      this.createdCollections.add(current)
    }
  }
}
