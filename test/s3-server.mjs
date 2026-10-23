/**
 * Small S3-compatible server for tests. It verifies AWS Signature V4, supports
 * ListObjectsV2 with pagination, conditional PUT, GET/HEAD, and DELETE, and
 * stores objects in memory.
 */
import http from 'node:http'
import crypto from 'node:crypto'

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest()
}

function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function xmlError(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${esc(message)}</Message></Error>`
}

function parseQuery(rawQuery) {
  const pairs = []
  if (!rawQuery) return pairs
  for (const part of rawQuery.split('&')) {
    if (!part) continue
    const index = part.indexOf('=')
    const name = index === -1 ? part : part.slice(0, index)
    const value = index === -1 ? '' : part.slice(index + 1)
    pairs.push([decodeURIComponent(name), decodeURIComponent(value)])
  }
  return pairs
}

function canonicalQuery(pairs) {
  return pairs
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function startS3Server(options) {
  const bucket = options.bucket
  const accessKeyId = options.accessKeyId
  const secretAccessKey = options.secretAccessKey
  const region = options.region ?? 'us-east-1'
  const pageSize = options.pageSize ?? 1000
  const objects = new Map()

  function verify(req, rawPath, rawQuery, body) {
    const authorization = req.headers.authorization ?? ''
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d+)\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(authorization)
    if (!match) return 'invalid header: authorization'
    const [, keyId, date, signedRegion, signedHeaders, signature] = match
    if (keyId !== accessKeyId) return 'The access key does not exist'
    if (signedRegion !== region) return 'region mismatch'
    const names = signedHeaders.split(';')
    const headerLines = []
    for (const name of names) {
      const value = name === 'host' ? req.headers.host : req.headers[name]
      if (value === undefined) return `missing signed header ${name}`
      headerLines.push(`${name}:${String(value).trim()}`)
    }
    const payloadHash = req.headers['x-amz-content-sha256'] ?? sha256Hex(body)
    if (sha256Hex(body) !== payloadHash) return 'XAmzContentSHA256Mismatch'
    const canonicalRequest = [
      req.method,
      rawPath,
      canonicalQuery(parseQuery(rawQuery)),
      `${headerLines.join('\n')}\n`,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const timestamp = req.headers['x-amz-date']
    const scope = `${date}/${region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n')
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 's3'), 'aws4_request')
    const expected = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    return expected === signature ? undefined : 'The request signature we calculated does not match the signature you provided'
  }

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '/'
    const queryIndex = rawUrl.indexOf('?')
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
    const rawQuery = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1)
    const body = await readBody(req)
    const signatureProblem = verify(req, rawPath, rawQuery, body)
    if (signatureProblem !== undefined) {
      res.writeHead(403, { 'content-type': 'application/xml' }).end(xmlError('SignatureDoesNotMatch', signatureProblem))
      return
    }
    const decoded = decodeURIComponent(rawPath)
    const bucketPrefix = `/${bucket}`
    if (decoded !== bucketPrefix && !decoded.startsWith(`${bucketPrefix}/`)) {
      res.writeHead(404, { 'content-type': 'application/xml' }).end(xmlError('NoSuchBucket', 'bucket not found'))
      return
    }
    const key = decoded === bucketPrefix ? '' : decoded.slice(bucketPrefix.length + 1)
    const query = new Map(parseQuery(rawQuery))

    if (req.method === 'GET' && key === '' && query.get('list-type') === '2') {
      const prefix = query.get('prefix') ?? ''
      const offset = Number(query.get('continuation-token') ?? 0) || 0
      const maxKeys = Math.min(Number(query.get('max-keys') ?? pageSize) || pageSize, pageSize)
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort()
      const slice = keys.slice(offset, offset + maxKeys)
      const truncated = offset + maxKeys < keys.length
      const contents = slice.map((name) => {
        const item = objects.get(name)
        return `<Contents><Key>${esc(name)}</Key><LastModified>${new Date(item.mtimeMs).toISOString()}</LastModified><ETag>${esc(item.etag)}</ETag><Size>${item.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`
      }).join('')
      const next = truncated ? `<NextContinuationToken>${offset + maxKeys}</NextContinuationToken>` : ''
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${slice.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`
      res.writeHead(200, { 'content-type': 'application/xml' }).end(xml)
      return
    }

    if (key === '') {
      if (req.method === 'HEAD' || req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/xml', 'x-amz-bucket-region': region }).end()
        return
      }
      res.writeHead(405).end()
      return
    }

    if (req.method === 'PUT') {
      const current = objects.get(key)
      if (req.headers['if-none-match'] === '*' && current) {
        res.writeHead(412, { 'content-type': 'application/xml' }).end(xmlError('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'))
        return
      }
      if (req.headers['if-match'] && (!current || current.etag !== req.headers['if-match'])) {
        res.writeHead(412, { 'content-type': 'application/xml' }).end(xmlError('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'))
        return
      }
      const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`
      objects.set(key, { body, etag, mtimeMs: Date.now() })
      res.writeHead(200, { etag, 'content-type': 'application/xml' }).end()
      return
    }

    const item = objects.get(key)
    if (!item) {
      res.writeHead(404, { 'content-type': 'application/xml' }).end(xmlError('NoSuchKey', 'The specified key does not exist.'))
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const headers = {
        etag: item.etag,
        'content-length': item.body.length,
        'last-modified': new Date(item.mtimeMs).toUTCString(),
        'content-type': 'application/octet-stream',
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, headers).end()
        return
      }
      res.writeHead(200, headers).end(item.body)
      return
    }

    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204).end()
      return
    }

    res.writeHead(405, { 'content-type': 'application/xml' }).end(xmlError('MethodNotAllowed', 'method not allowed'))
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
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    bucket,
    objects,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
