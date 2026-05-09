# OpenVINO Bridge Protocol (Browser <-> Local Service)

This demo can switch gaze backend to `OpenVINO Bridge` from the UI button:

- `Backend: MediaPipe` -> `Backend: OpenVINO Bridge`

When bridge mode is active, browser connects to:

- `ws://127.0.0.1:8765`

## Quick Start (Local)

1. Install Python deps:

```bash
pip install -r tools/requirements-openvino-bridge.txt
```

2. Start bridge with OpenCV fallback (no AI acceleration; demo path
   only — the UI will surface this as `OpenCV-CPU` so the audience
   knows they're not seeing the OpenVINO upgrade):

```bash
python tools/openvino_bridge_server.py --host 127.0.0.1 --port 8765
```

3. **Recommended for AI PC demos.** Use OpenVINO models with the AUTO
   device chain (tries NPU, then GPU, then CPU). The browser will
   surface the actual device selected:

```bash
python tools/openvino_bridge_server.py \
  --face-model C:/models/face-detection-adas-0001.xml \
  --headpose-model C:/models/head-pose-estimation-adas-0001.xml
```

Override the device chain explicitly if needed:

```bash
# Force NPU only — fails fast if NPU unavailable instead of falling back.
python tools/openvino_bridge_server.py \
  --face-model C:/models/face-detection-adas-0001.xml \
  --headpose-model C:/models/head-pose-estimation-adas-0001.xml \
  --device NPU
```

4. Open demo and click:
- `Enable Webcam Mode`
- `Backend: OpenVINO Bridge`

If bridge is unavailable, frontend auto-falls back to MediaPipe.

## Browser -> Service

The browser sends JSON message:

```json
{
  "type": "frame",
  "width": 160,
  "height": 120,
  "image": "data:image/jpeg;base64,...",
  "ts": 123456.78
}
```

## Service -> Browser

On connect, the service sends a `hello` handshake announcing the live backend
and the actual device that was compiled for. The browser uses this to render
the visible status pill ("Intel NPU 3.4ms"):

```json
{
  "type": "hello",
  "protocol": 1,
  "backend": "openvino",
  "device": "NPU",
  "face_model": "face-detection-adas-0001.xml",
  "headpose_model": "head-pose-estimation-adas-0001.xml",
  "ts": 1715284123.45
}
```

Possible `backend`/`device` combos:

| backend     | device                         | meaning |
|-------------|--------------------------------|---------|
| `openvino`  | `NPU` / `GPU` / `CPU`          | OpenVINO models compiled on the named Intel device |
| `opencv`    | `OpenCV-CPU`                   | Models not provided; Haar cascade head-center fallback |

Per-frame gaze responses include rolling inference latency (`inferenceMs`):

```json
{
  "type": "gaze",
  "x": 0.53,
  "y": 0.47,
  "quality": 0.88,
  "inferenceMs": 3.4
}
```

Notes:

- `x` and `y` are normalized screen coordinates in `[0, 1]`.
- `quality` is optional; fallback is handled in client.
- `inferenceMs` is the EMA of the per-frame model inference time and drives
  the live latency chip in the demo UI.

The service also responds to a `ping` heartbeat with `{"type":"pong"}` —
used by the browser auto-probe so the UI can preview backend availability
without forcing a full webcam stream.

## Fallback behavior

If bridge is unreachable or errors:

- client auto-falls back to `MediaPipe`.
- status is shown in debug text when enabled.

## Performance tips

- Keep browser tab visible and webcam at eye level.
- Run bridge on same machine as browser.
- Prefer OpenVINO mode with model files for better stability.
