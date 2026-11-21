import { computeTerrainBuffers } from './terrain-core.js';

self.onmessage = () => {
  try {
    const bufs = computeTerrainBuffers((pct, label) => {
      self.postMessage({ type: 'progress', pct, label });
    });
    const transfer = [
      bufs.D.buffer,
      bufs.wp.buffer,
      bufs.wn.buffer,
      bufs.aoArr.buffer,
      bufs.indices.buffer,
      bufs.skirtPos.buffer,
      bufs.skirtNorm.buffer,
      bufs.skirtAo.buffer,
      bufs.skirtIdx.buffer,
      bufs.volData.buffer,
      bufs.zoneData.buffer,
    ];
    self.postMessage({ type: 'done', bufs }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
