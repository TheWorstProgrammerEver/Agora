import { Buffer } from 'node:buffer'

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  }
  return crc >>> 0
})

const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const localHeader = (name, bytes, checksum) => {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(33, 12)
  header.writeUInt32LE(checksum, 14)
  header.writeUInt32LE(bytes.length, 18)
  header.writeUInt32LE(bytes.length, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

const centralHeader = (name, bytes, checksum, offset) => {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(0x0314, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(33, 14)
  header.writeUInt32LE(checksum, 16)
  header.writeUInt32LE(bytes.length, 20)
  header.writeUInt32LE(bytes.length, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  header.writeUInt32LE(offset, 42)
  return header
}

const endRecord = (count, centralSize, centralOffset) => {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(0x06054b50, 0)
  record.writeUInt16LE(0, 4)
  record.writeUInt16LE(0, 6)
  record.writeUInt16LE(count, 8)
  record.writeUInt16LE(count, 10)
  record.writeUInt32LE(centralSize, 12)
  record.writeUInt32LE(centralOffset, 16)
  record.writeUInt16LE(0, 20)
  return record
}

const validateName = (name) => {
  if (!/^[a-z0-9][a-z0-9./-]*$/i.test(name)
    || name.startsWith('/')
    || name.split('/').includes('..')) {
    throw new Error(`Unsafe skill archive entry: ${name}`)
  }
}

export const createStoredZip = (sources) => {
  const entries = [...sources]
    .map(({ name, source }) => ({
      bytes: Buffer.from(source, 'utf8'),
      name: Buffer.from(name, 'utf8'),
      path: name
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

  if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
    throw new Error('Skill archive contains duplicate entries.')
  }

  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    validateName(entry.path)
    const checksum = crc32(entry.bytes)
    const local = localHeader(entry.name, entry.bytes, checksum)
    const central = centralHeader(entry.name, entry.bytes, checksum, offset)
    localParts.push(local, entry.name, entry.bytes)
    centralParts.push(central, entry.name)
    offset += local.length + entry.name.length + entry.bytes.length
  }

  const localBytes = Buffer.concat(localParts)
  const centralBytes = Buffer.concat(centralParts)
  return Buffer.concat([
    localBytes,
    centralBytes,
    endRecord(entries.length, centralBytes.length, localBytes.length)
  ])
}

export const readStoredZip = (source) => {
  const bytes = Buffer.from(source)
  const entries = new Map()
  let offset = 0

  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const compression = bytes.readUInt16LE(offset + 8)
    const size = bytes.readUInt32LE(offset + 18)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    if (compression !== 0) throw new Error('Skill archive entry is compressed unexpectedly.')
    const nameStart = offset + 30
    const contentStart = nameStart + nameLength + extraLength
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const content = bytes.subarray(contentStart, contentStart + size)
    if (entries.has(name) || content.length !== size) throw new Error('Skill archive is invalid.')
    entries.set(name, content)
    offset = contentStart + size
  }

  return entries
}
