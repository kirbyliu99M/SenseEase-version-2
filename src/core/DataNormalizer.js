export class DataNormalizer {
  constructor(bufferSize = 60) {
    this.bufferSize = bufferSize;
    this.buffer = [];
  }

  // 即時 Z-score 常態化 x_norm = (x_raw - mu) / sigma
  normalize(rawFeatures) {
    this.buffer.push(rawFeatures);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }

    if (this.buffer.length < 2) return rawFeatures; 

    const keys = Object.keys(rawFeatures);
    const normalized = {};

    keys.forEach(key => {
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        sum += this.buffer[i][key];
      }
      const mu = sum / this.buffer.length;

      let varianceSum = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        varianceSum += Math.pow(this.buffer[i][key] - mu, 2);
      }
      let sigma = Math.sqrt(varianceSum / this.buffer.length);
      if (sigma === 0) sigma = 1; // 避免除以零

      normalized[key] = (rawFeatures[key] - mu) / sigma;
    });

    return normalized;
  }
}
