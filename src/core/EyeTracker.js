export class EyeTracker {
  constructor() {
    this.screenCenterX = window.innerWidth / 2;
    this.screenCenterY = window.innerHeight / 2;
  }

  // 模擬 TF.js FaceMesh 擷取 11 項幾何特徵
  extractFeatures(mouseX, mouseY) {
    const features = {
      pupilPosXLeft: mouseX - 30,
      pupilPosYLeft: mouseY,
      pupilPosXRight: mouseX + 30,
      pupilPosYRight: mouseY,
      pupilDiameterLeft: 4.5 + Math.random() * 0.5,
      pupilDiameterRight: 4.5 + Math.random() * 0.5,
      saccadeVelocity: Math.random() * 100, 
      gazeOriginX: mouseX,
      gazeOriginY: mouseY,
      gazeOriginZ: 600, 
    };

    // 螢幕中心凝視偏差 (Gaze deviation): d_xy = (xb-xo)^2 + (yb-yo)^2
    features.gazeDeviation = Math.pow(features.gazeOriginX - this.screenCenterX, 2) + Math.pow(features.gazeOriginY - this.screenCenterY, 2);

    return features;
  }
}
