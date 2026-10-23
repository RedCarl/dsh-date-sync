/**
 * Remote backend factory. Both clients share the small interface the sync
 * engine uses: walk, stat, get, put, delete, ensureCollection, and a
 * `createdCollections` Set for WebDAV's MKCOL cache.
 */
import { WebdavClient } from './webdav.js'
import { S3Client } from './s3.js'

export function createRemoteClient(config) {
  if (config.provider === 's3') {
    return new S3Client({
      endpoint: config.url,
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.username,
      secretAccessKey: config.password,
      sessionToken: config.sessionToken,
      pathStyle: config.pathStyle,
      timeoutMs: config.requestTimeoutMs,
    })
  }
  return new WebdavClient({
    url: config.url,
    username: config.username,
    password: config.password,
    timeoutMs: config.requestTimeoutMs,
  })
}
