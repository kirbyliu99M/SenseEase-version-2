export class VIMSPredictor {
  constructor() {
    this.history = [];
    this.lastPredictionTime = performance.now();
    this.lastScore = 0;
  }

  // ALSTM-FCN 架構預測 (1秒/5秒滾動更新)
  predict(normalizedFeatures) {
    const now = performance.now();
    this.history.push({ time: now, data: normalizedFeatures });
    
    // 保留過去 5 秒的 Window
    this.history = this.history.filter(h => now - h.time <= 5000);

    // 每秒高頻預測一次
    if (now - this.lastPredictionTime >= 1000) {
      this.lastPredictionTime = now;
      
      // 模擬 Conv1D + LSTM + Attention 的計算結果
      // W_ij = exp(h_i^T h_j) / sum(...) 的局部特徵聚焦
      let sumDeviation = 0;
      this.history.forEach(item => {
         sumDeviation += Math.abs(item.data.gazeDeviation || 0);
      });
      const avgDev = this.history.length > 0 ? sumDeviation / this.history.length : 0;
      
      // 輸出動暈症壓力指數 0 (None) 至 3 (Severe)
      let score = 0;
      if (avgDev > 2) score = 3;
      else if (avgDev > 1) score = 2;
      else if (avgDev > 0.5) score = 1;

      this.lastScore = score;
    }
    return this.lastScore; 
  }
}
