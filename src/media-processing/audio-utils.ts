/** Lee la última posición granular de páginas Ogg sin decodificar el audio. */
export function estimateOggDurationSeconds(bytes: Uint8Array): number | null {
  let offset = 0;
  let lastGranule = 0n;
  let foundPage = false;

  while (offset + 27 <= bytes.length) {
    if (
      bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 ||
      bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53
    ) {
      return null;
    }

    const segmentCount = bytes[offset + 26] ?? 0;
    const tableEnd = offset + 27 + segmentCount;
    if (tableEnd > bytes.length) return null;

    let payloadLength = 0;
    for (let i = offset + 27; i < tableEnd; i += 1) payloadLength += bytes[i] ?? 0;
    const nextPage = tableEnd + payloadLength;
    if (nextPage > bytes.length) return null;

    let granule = 0n;
    for (let i = 0; i < 8; i += 1) {
      granule |= BigInt(bytes[offset + 6 + i] ?? 0) << BigInt(i * 8);
    }
    // -1 indica que esta página no tiene una posición granular válida.
    if (granule !== 0xffffffffffffffffn && granule > lastGranule) lastGranule = granule;
    foundPage = true;
    offset = nextPage;
  }

  if (!foundPage || offset !== bytes.length) return null;
  return Number(lastGranule) / 48_000;
}
