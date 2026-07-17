export function mixToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array();
  if (channelData.length === 1) return channelData[0] ?? new Float32Array();

  const length = Math.min(...channelData.map((channel) => channel.length));
  const output = new Float32Array(length);
  for (const channel of channelData) {
    for (let i = 0; i < length; i += 1) {
      output[i] = (output[i] ?? 0) + (channel[i] ?? 0) / channelData.length;
    }
  }
  return output;
}

export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16_000) return input;
  if (inputRate < 16_000 || inputRate % 16_000 !== 0) {
    throw new Error(`Frecuencia de audio no compatible: ${inputRate} Hz.`);
  }

  const ratio = inputRate / 16_000;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

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
