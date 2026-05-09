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

2. **Recommended for first-time setup.** Drop the OpenVINO IR files into
   the repo's `models/` folder (see `models/README.md` for download
   instructions) and run the server with no extra arguments:

```bash
python tools/openvino_bridge_server.py
```

   The server auto-discovers `models/face-detection-adas-0001.xml` and
   `models/head-pose-estimation-adas-0001.xml`. Use this path for booth
   demos so a fresh machine doesn't need command-line gymnastics.

3. Without models in `models/`, the server falls back to OpenCV Haar
   cascade and emits a clear warning. The browser pill shows
   `OpenCV (no AI accel)`:

```bash
python tools/openvino_bridge_server.py --host 127.0.0.1 --port 8765
```

4. **Explicit model paths.** Override the auto-discovery if your IR files
   live elsewhere:

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
  "precision": "FP16",
  "ts": 1715284123.45
}
```

The `precision` field reports which IR weights the server actually loaded:

| Precision      | Selected when |
|----------------|--------------|
| `FP16`         | Device chain picked **NPU** (NPU only accepts FP16) |
| `FP32`         | Device chain picked **GPU** or **CPU** |
| `FP16-INT8`    | Only if explicitly the only option present |

The browser pill renders this as e.g. `Intel NPU · FP16 · 3.4 ms`.

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

## Windows: firewall / Defender

The first time the bridge listens on `127.0.0.1:8765`, Windows Defender may
prompt for an inbound rule. Choose **Allow** for *Private* networks. If you
denied by mistake, remove the blocking rule:

1. Open `wf.msc` (Windows Defender Firewall with Advanced Security)
2. **Inbound Rules** → find any deny rule for `python.exe`
3. Right-click → **Delete** (or right-click → **Properties** → set Action to
   *Allow the connection*)
4. Restart the bridge server

## Resilience notes (client side)

- **Probe**: the browser tries connecting up to 3 times (1.5 s → 3 s → 5 s)
  to cover OpenVINO cold-boot windows where model compile + NPU init can
  take 5–15 s.
- **Reconnect**: a transient WebSocket close triggers up to 3 retries with
  exponential backoff (1 s / 2 s / 5 s) before downgrading to MediaPipe.
- **Persisted backend**: if the user previously selected `OpenVINO Bridge`
  but the server isn't running on this load, the UI silently downgrades to
  MediaPipe ~11 s after page load (after the probe sequence completes).
