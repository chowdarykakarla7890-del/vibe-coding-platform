export function utf8ByteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(value) <= maxBytes) return value

  const encoded = new TextEncoder().encode(value)
  let end = Math.min(encoded.byteLength, maxBytes)
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(encoded.slice(0, end))
}
