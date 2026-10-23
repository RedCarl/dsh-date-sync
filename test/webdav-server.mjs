/**
 * A small WebDAV server used only by the sync tests. It implements PROPFIND
 * (Depth 0/1), GET, PUT, DELETE, MKCOL, HEAD, and OPTIONS with Basic auth,
 * enough to exercise the plugin's client end to end without network access.
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const DAV = '/dav'

function deserializePath(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname)
  if (pathname !== DAV && !pathname.startsWith(`${DAV}/`)) return null
  const rel = pathname.slice(DAV.length).replace(/^\/+|\/+$/g, '')
  const segments = rel === '' ? [] : rel.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  return segments
}

function hrefFor(segments, isDir) {
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/')
  return `${DAV}/${encoded}${isDir ? '/' : ''}`.replace(/\/{2,}/g, '/').replace(/^\/dav\/?$/, `${DAV}/`)
}

async function etagOf(abs) {
  try {
    const content = await fsp.readFile(abs)
    return `"${crypto.createHash('sha1').update(content).digest('hex')}"`
  } catch {
    return undefined
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function responseXml(abs, segments) {
  const stat = await fsp.stat(abs)
  const isDir = stat.isDirectory()
  const props = isDir
    ? '<d:resourcetype><d:collection/></d:resourcetype>'
    : [
        '<d:resourcetype/>',
        `<d:getetag>${escapeXml(await etagOf(abs))}</d:getetag>`,
        `<d:getcontentlength>${stat.size}</d:getcontentlength>`,
        `<d:getlastmodified>${stat.mtime.toUTCString()}</d:getlastmodified>`,
      ].join('')
  return [
    '<d:response>',
    `<d:href>${escapeXml(hrefFor(segments, isDir))}</d:href>`,
    '<d:propstat><d:prop>',
    props,
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
    '</d:response>',
  ].join('')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start a WebDAV server.
 * @param {object} options
 * @param {string} options.root Directory that backs the `/dav` collection.
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.username]
 * @param {string} [options.password]
 */
export async function startWebdavServer(options) {
  const root = path.resolve(options.root)
  await fsp.mkdir(root, { recursive: true })
  const expectedAuth = options.username
    ? `Basic ${Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')}`
    : undefined

  const server = http.createServer(async (req, res) => {
    try {
      if (expectedAuth && req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
        res.end()
        return
      }
      const segments = deserializePath(req.url)
      if (segments === null) {
        res.writeHead(404).end()
        return
      }
      const abs = path.join(root, ...segments)
      if (!abs.startsWith(root)) {
        res.writeHead(403).end()
        return
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(200, { Allow: 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, HEAD', DAV: '1' }).end()
        return
      }

      if (req.method === 'PROPFIND') {
        const depth = req.headers.depth === '0' ? 0 : 1
        let stat
        try {
          stat = await fsp.stat(abs)
        } catch {
          res.writeHead(404).end()
          return
        }
        const parts = [await responseXml(abs, segments)]
        if (stat.isDirectory() && depth === 1) {
          for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
            parts.push(await responseXml(path.join(abs, entry.name), [...segments, entry.name]))
          }
        }
        const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        res.end(body)
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        let stat
        try {
          stat = await fsp.stat(abs)
        } catch {
          res.writeHead(404).end()
          return
        }
        if (stat.isDirectory()) {
          res.writeHead(405).end()
          return
        }
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Last-Modified': stat.mtime.toUTCString(),
          ETag: await etagOf(abs),
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, headers).end()
          return
        }
        res.writeHead(200, headers)
        fs.createReadStream(abs).pipe(res)
        return
      }

      if (req.method === 'PUT') {
        const body = await readBody(req)
        let current
        try {
          current = await fsp.stat(abs)
        } catch {
          current = undefined
        }
        if (req.headers['if-none-match'] === '*' && current) {
          res.writeHead(412).end()
          return
        }
        if (req.headers['if-match']) {
          const currentEtag = current ? await etagOf(abs) : undefined
          if (!currentEtag || currentEtag !== req.headers['if-match']) {
            res.writeHead(412).end()
            return
          }
        }
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await fsp.writeFile(abs, body)
        res.writeHead(current ? 204 : 201, { ETag: await etagOf(abs) })
        res.end()
        return
      }

      if (req.method === 'MKCOL') {
        try {
          await fsp.stat(abs)
          res.writeHead(405).end()
          return
        } catch {
          // Not existing yet: create it.
        }
        await fsp.mkdir(abs, { recursive: true })
        res.writeHead(201).end()
        return
      }

      if (req.method === 'DELETE') {
        await fsp.rm(abs, { recursive: true, force: true })
        res.writeHead(204).end()
        return
      }

      res.writeHead(405).end()
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(error?.stack ?? error))
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    server,
    port,
    url: `http://${options.host ?? '127.0.0.1'}:${port}${DAV}`,
    root,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.WEBDAV_PORT ?? 8099)
  const root = process.env.WEBDAV_ROOT ?? path.join(process.cwd(), '.webdav-root')
  const started = await startWebdavServer({
    root,
    port,
    username: process.env.WEBDAV_USER,
    password: process.env.WEBDAV_PASS,
  })
  console.log(`WebDAV test server: ${started.url} (root ${started.root})`)
}
