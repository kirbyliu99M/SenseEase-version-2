export class EyeTracker {
  constructor() {
    this.screenCenterX = window.innerWidth / 2;
    this.screenCenterY = window.innerHeight / 2;
    // gazeOverride: when set to {x, y}, overrides mouseX/mouseY as the gaze
    // origin. Populated by the GazeTracker (MediaPipe) when webcam mode is on.
    this.gazeOverride = null;
  }

  // Sample 11 geometric features from gaze input. Falls back to mouse pos
  // when no webcam-driven gaze override is active.
  extractFeatures(mouseX, mouseY) {
    const gx = this.gazeOverride ? this.gazeOverride.x : mouseX;
    const gy = this.gazeOverride ? this.gazeOverride.y : mouseY;

    const features = {
      pupilPosXLeft: gx - 30,
      pupilPosYLeft: gy,
      pupilPosXRight: gx + 30,
      pupilPosYRight: gy,
      pupilDiameterLeft: 4.5 + Math.random() * 0.5,
      pupilDiameterRight: 4.5 + Math.random() * 0.5,
      saccadeVelocity: Math.random() * 100,
      gazeOriginX: gx,
      gazeOriginY: gy,
      gazeOriginZ: 600,
    };

    features.gazeDeviation = Math.pow(features.gazeOriginX - this.screenCenterX, 2)
                           + Math.pow(features.gazeOriginY - this.screenCenterY, 2);

    return features;
  }
}
