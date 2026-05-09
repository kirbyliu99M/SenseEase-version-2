#!/usr/bin/env python3
"""
SenseEase OpenVINO Gaze Bridge

WebSocket server that accepts low-res webcam frames from browser and emits
normalized gaze coordinates:
  { "type": "gaze", "x": 0..1, "y": 0..1, "quality": 0..1 }

Backend priority:
1) OpenVINO (face detection + head pose) when model paths are provided.
2) OpenCV Haar face-center fallback (still useful for head movement).

Usage:
  python tools/openvino_bridge_server.py --host 127.0.0.1 --port 8765

OpenVINO mode:
  python tools/openvino_bridge_server.py \
    --face-model <face-detection-adas-0001.xml> \
    --headpose-model <head-pose-estimation-adas-0001.xml>
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import signal
import time
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np
import websockets

# websockets >=12 moved WebSocketServerProtocol out of `.server` into
# `.legacy.server`. Try both paths so the bridge runs on a wider range of
# host installs without forcing a downgrade.
try:
    from websockets.server import WebSocketServerProtocol  # websockets <12
except ImportError:
    try:
        from websockets.legacy.server import WebSocketServerProtocol  # websockets >=12
    except ImportError:
        WebSocketServerProtocol = object  # last-resort: type hint only

try:
    from openvino.runtime import Core  # type: ignore
except Exception:
    Core = None


# Bundled-model search path. Lets users `python openvino_bridge_server.py`
# without --face-model arguments by dropping the IR files at this relative
# location. The repo can ship them in `models/` so first-time users get
# OpenVINO acceleration without reading the protocol doc.
_BUNDLED_MODELS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "models",
)


_FACE_CANDIDATES = [
    "face-detection-adas-0001.xml",
    "face-detection-retail-0004.xml",
]
_HEAD_CANDIDATES = [
    "head-pose-estimation-adas-0001.xml",
]


def _find_in_dir(dir_path: str, candidates: list) -> Optional[str]:
    """Return the first existing candidate filename in dir_path, else None."""
    if not os.path.isdir(dir_path):
        return None
    for name in candidates:
        p = os.path.join(dir_path, name)
        if os.path.isfile(p):
            return p
    return None


def _autodiscover_models() -> dict:
    """Look for OpenVINO IR pairs in the repo's models/ folder, grouped by
    precision. Supports three layout styles, in order of preference:

    1) Per-precision subfolders:
         models/FP16/face-detection-adas-0001.xml
         models/FP32/head-pose-estimation-adas-0001.xml

    2) omz_downloader native nesting (kept verbatim, no manual flatten):
         models/intel/face-detection-adas-0001/FP16/...
         models/intel/head-pose-estimation-adas-0001/FP32/...

    3) Flat (legacy):
         models/face-detection-adas-0001.xml
         models/head-pose-estimation-adas-0001.xml
       — assumed FP16 if precision is unknown.

    Returns dict {precision: (face_xml, head_xml)}. Empty dict means nothing
    was found.
    """
    result: dict = {}
    if not os.path.isdir(_BUNDLED_MODELS_DIR):
        return result

    # Style 1: per-precision subfolders directly under models/
    for precision in ("FP16", "FP32", "FP16-INT8"):
        sub = os.path.join(_BUNDLED_MODELS_DIR, precision)
        face = _find_in_dir(sub, _FACE_CANDIDATES)
        head = _find_in_dir(sub, _HEAD_CANDIDATES)
        if face and head:
            result[precision] = (face, head)

    # Style 2: omz_downloader nesting (models/intel/<model>/<precision>/...)
    intel_dir = os.path.join(_BUNDLED_MODELS_DIR, "intel")
    if os.path.isdir(intel_dir):
        for precision in ("FP16", "FP32", "FP16-INT8"):
            if precision in result:
                continue  # style 1 already won
            face = None
            head = None
            for face_name in _FACE_CANDIDATES:
                base = face_name.replace(".xml", "")
                cand = os.path.join(intel_dir, base, precision, face_name)
                if os.path.isfile(cand):
                    face = cand
                    break
            for head_name in _HEAD_CANDIDATES:
                base = head_name.replace(".xml", "")
                cand = os.path.join(intel_dir, base, precision, head_name)
                if os.path.isfile(cand):
                    head = cand
                    break
            if face and head:
                result[precision] = (face, head)

    # Style 3: flat fallback. Treat as FP16 unless we already discovered one.
    if "FP16" not in result and "FP32" not in result:
        face = _find_in_dir(_BUNDLED_MODELS_DIR, _FACE_CANDIDATES)
        head = _find_in_dir(_BUNDLED_MODELS_DIR, _HEAD_CANDIDATES)
        if face and head:
            result["FP16"] = (face, head)

    return result


def _pick_precision(available_precisions: list, ov_devices: list, device_chain: list) -> str:
    """Pick the best available precision given the devices we plan to try.

    Rules:
      - NPU is the first usable device in the chain → prefer FP16 (NPU spec).
      - GPU is the first usable device in the chain → prefer FP32 (matches
        Intel iGPU/Arc behavior; FP16 still works but FP32 has wider op support).
      - CPU first → prefer FP32.
      - INT8 is opt-in: only used if explicitly the only option available.
    """
    if not available_precisions:
        return ""

    # Resolve the first device that's actually available.
    first_runnable = None
    avail = set(d.upper() for d in ov_devices)
    for d in device_chain:
        if d.upper() in avail:
            first_runnable = d.upper()
            break

    if first_runnable == "NPU":
        for p in ("FP16", "FP16-INT8", "FP32"):
            if p in available_precisions:
                return p
    if first_runnable in ("GPU", "CPU"):
        for p in ("FP32", "FP16", "FP16-INT8"):
            if p in available_precisions:
                return p

    # No clear device match — fall back to whatever is present, FP16 first
    # (smaller, runs almost everywhere).
    for p in ("FP16", "FP32", "FP16-INT8"):
        if p in available_precisions:
            return p
    return list(available_precisions)[0]


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def decode_data_url_jpeg(data_url: str) -> Optional[np.ndarray]:
    if not data_url.startswith("data:image/"):
        return None
    comma = data_url.find(",")
    if comma < 0:
        return None
    b64 = data_url[comma + 1 :]
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return frame


@dataclass
class GazeState:
    x: float = 0.5
    y: float = 0.5
    quality: float = 0.0
    ready: bool = False
    hz_ema: float = 0.0
    last_ts: float = 0.0

    def update_hz(self, now: float) -> None:
        if self.last_ts > 0:
            dt = max(1 / 120, now - self.last_ts)
            hz = 1.0 / dt
            self.hz_ema = hz if self.hz_ema == 0 else _lerp(self.hz_ema, hz, 0.1)
        self.last_ts = now


class OpenVinoHeadPoseBackend:
    """OpenVINO head-pose-driven gaze proxy.

    Compiles models against the first available device in `device_chain`:
    by default tries NPU → GPU → CPU. The actually-used device is exposed
    via `self.actual_device` so the WebSocket layer can advertise it to
    clients in the hello handshake — that's the key signal demo audiences
    look at to confirm the AI PC NPU is doing real work.
    """

    def __init__(
        self,
        face_model_xml: str,
        head_model_xml: str,
        device_chain: Optional[list] = None,
    ):
        if Core is None:
            raise RuntimeError("openvino.runtime is not installed")

        self.core = Core()
        self.face_model = self.core.read_model(face_model_xml)
        self.head_model = self.core.read_model(head_model_xml)

        chain = device_chain or ["NPU", "GPU", "CPU"]
        available = set(self.core.available_devices)
        logging.info("OpenVINO available_devices = %s", sorted(available))

        last_err = None
        compiled = None
        for candidate in chain:
            if candidate not in available and not candidate.startswith("AUTO"):
                logging.info("Skipping device %s (not in available_devices)", candidate)
                continue
            try:
                logging.info("Compiling face+headpose models on device=%s", candidate)
                self.face_compiled = self.core.compile_model(self.face_model, candidate)
                self.head_compiled = self.core.compile_model(self.head_model, candidate)
                self.actual_device = candidate
                compiled = candidate
                break
            except Exception as e:
                last_err = e
                logging.warning("Compile on %s failed: %s — trying next", candidate, e)
                continue

        if compiled is None:
            raise RuntimeError(
                f"Could not compile OpenVINO models on any of {chain}. "
                f"Last error: {last_err}"
            )

        self.face_input = self.face_compiled.input(0)
        self.face_output = self.face_compiled.output(0)
        self.head_input = self.head_compiled.input(0)
        self.head_outputs = [o.get_any_name() for o in self.head_compiled.outputs]

        _, _, self.face_h, self.face_w = self.face_input.shape
        _, _, self.head_h, self.head_w = self.head_input.shape

        # Rolling inference timing exposed in every gaze response — drives the
        # live latency chip in the browser UI.
        self.last_infer_ms = 0.0
        self.ema_infer_ms = 0.0
        self.face_model_path = face_model_xml
        self.head_model_path = head_model_xml
        self.face_model_name = os.path.basename(face_model_xml)
        self.head_model_name = os.path.basename(head_model_xml)

        logging.info(
            "OpenVINO backend ready | device=%s | face=%s | headpose=%s",
            self.actual_device,
            self.face_model_name,
            self.head_model_name,
        )

    @staticmethod
    def _blob_from_bgr(img: np.ndarray, w: int, h: int) -> np.ndarray:
        resized = cv2.resize(img, (w, h), interpolation=cv2.INTER_LINEAR)
        blob = resized.transpose(2, 0, 1)[np.newaxis, :].astype(np.float32)
        return blob

    @staticmethod
    def _pick_largest_face(dets: np.ndarray, fw: int, fh: int) -> Optional[Tuple[int, int, int, int, float]]:
        best = None
        best_area = 0.0
        for d in dets.reshape(-1, 7):
            conf = float(d[2])
            if conf < 0.55:
                continue
            x1 = int(_clamp(float(d[3]), 0.0, 1.0) * fw)
            y1 = int(_clamp(float(d[4]), 0.0, 1.0) * fh)
            x2 = int(_clamp(float(d[5]), 0.0, 1.0) * fw)
            y2 = int(_clamp(float(d[6]), 0.0, 1.0) * fh)
            if x2 <= x1 or y2 <= y1:
                continue
            area = float((x2 - x1) * (y2 - y1))
            if area > best_area:
                best = (x1, y1, x2, y2, conf)
                best_area = area
        return best

    def estimate(self, frame_bgr: np.ndarray) -> Optional[Tuple[float, float, float]]:
        fh, fw = frame_bgr.shape[:2]
        infer_start = time.perf_counter()
        face_blob = self._blob_from_bgr(frame_bgr, self.face_w, self.face_h)
        dets = self.face_compiled([face_blob])[self.face_output]
        face = self._pick_largest_face(dets, fw, fh)
        if not face:
            self.last_infer_ms = (time.perf_counter() - infer_start) * 1000.0
            self.ema_infer_ms = (
                self.last_infer_ms if self.ema_infer_ms == 0
                else _lerp(self.ema_infer_ms, self.last_infer_ms, 0.2)
            )
            return None
        x1, y1, x2, y2, conf = face
        pad = int(0.15 * max(x2 - x1, y2 - y1))
        x1 = max(0, x1 - pad)
        y1 = max(0, y1 - pad)
        x2 = min(fw - 1, x2 + pad)
        y2 = min(fh - 1, y2 + pad)
        crop = frame_bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return None

        head_blob = self._blob_from_bgr(crop, self.head_w, self.head_h)
        out = self.head_compiled([head_blob])

        yaw = 0.0
        pitch = 0.0
        for name in self.head_outputs:
            val = float(np.squeeze(out[name]))
            n = name.lower()
            if "angle_y" in n:
                yaw = val
            elif "angle_p" in n:
                pitch = val

        # Convert head pose to normalized gaze-like target.
        # Yaw right -> x increases, pitch down -> y increases.
        nx = _clamp(yaw / 35.0, -1.0, 1.0)
        ny = _clamp(-pitch / 25.0, -1.0, 1.0)

        # Blend face center (macro movement) with pose (fine directional movement).
        cx_face = ((x1 + x2) * 0.5) / max(1, fw)
        cy_face = ((y1 + y2) * 0.5) / max(1, fh)
        x = 0.5 + nx * 0.26 + (cx_face - 0.5) * 0.45
        y = 0.5 + ny * 0.22 + (cy_face - 0.5) * 0.38
        x = _clamp(x, 0.0, 1.0)
        y = _clamp(y, 0.0, 1.0)
        quality = _clamp(0.55 + conf * 0.45, 0.0, 1.0)

        self.last_infer_ms = (time.perf_counter() - infer_start) * 1000.0
        self.ema_infer_ms = (
            self.last_infer_ms if self.ema_infer_ms == 0
            else _lerp(self.ema_infer_ms, self.last_infer_ms, 0.2)
        )
        return x, y, quality

    def describe(self) -> dict:
        # Infer precision from the loaded model path. Cheap and reliable —
        # avoids parsing the IR XML at hello time.
        precision = "?"
        for tag in ("FP16-INT8", "FP16", "FP32"):
            if tag in (self.face_model_path or "").upper():
                precision = tag
                break
        return {
            "type": "openvino",
            "device": self.actual_device,
            "face_model": self.face_model_name,
            "headpose_model": self.head_model_name,
            "precision": precision,
        }


class OpenCvFaceCenterBackend:
    actual_device = "OpenCV-CPU"
    last_infer_ms = 0.0
    ema_infer_ms = 0.0

    def __init__(self):
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        self.face = cv2.CascadeClassifier(cascade_path)
        if self.face.empty():
            raise RuntimeError("Failed to load haarcascade_frontalface_default.xml")
        logging.info("OpenCV fallback backend ready (no OpenVINO models loaded)")

    def describe(self) -> dict:
        return {
            "type": "opencv",
            "device": self.actual_device,
            "reason": "no OpenVINO models supplied",
        }

    def estimate(self, frame_bgr: np.ndarray) -> Optional[Tuple[float, float, float]]:
        infer_start = time.perf_counter()
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        faces = self.face.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=4, minSize=(18, 18))
        result = None
        if len(faces) > 0:
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            fh, fw = frame_bgr.shape[:2]
            cx = (x + w * 0.5) / max(1, fw)
            cy = (y + h * 0.5) / max(1, fh)
            nx = _clamp((cx - 0.5) * 1.3, -0.5, 0.5)
            ny = _clamp((cy - 0.5) * 1.1, -0.45, 0.45)
            gx = _clamp(0.5 + nx, 0.0, 1.0)
            gy = _clamp(0.5 + ny, 0.0, 1.0)
            area = (w * h) / max(1.0, fw * fh)
            quality = _clamp(0.45 + min(0.4, area * 8.0), 0.0, 1.0)
            result = (gx, gy, quality)

        self.last_infer_ms = (time.perf_counter() - infer_start) * 1000.0
        self.ema_infer_ms = (
            self.last_infer_ms if self.ema_infer_ms == 0
            else _lerp(self.ema_infer_ms, self.last_infer_ms, 0.2)
        )
        return result


class BridgeSession:
    def __init__(self, backend):
        self.backend = backend
        self.state = GazeState()

    def process_frame(self, frame: np.ndarray) -> Optional[dict]:
        now = time.perf_counter()
        self.state.update_hz(now)
        est = self.backend.estimate(frame)
        if est is None:
            # graceful decay to center, keep output available
            if self.state.ready:
                self.state.x = _lerp(self.state.x, 0.5, 0.03)
                self.state.y = _lerp(self.state.y, 0.5, 0.03)
                self.state.quality = _lerp(self.state.quality, 0.2, 0.12)
                return {
                    "type": "gaze",
                    "x": self.state.x,
                    "y": self.state.y,
                    "quality": self.state.quality,
                }
            return None

        gx, gy, q = est
        if not self.state.ready:
            self.state.ready = True
            self.state.x = gx
            self.state.y = gy
            self.state.quality = q
        else:
            alpha = 0.22 if q > 0.72 else 0.14
            self.state.x = _lerp(self.state.x, gx, alpha)
            self.state.y = _lerp(self.state.y, gy, alpha)
            self.state.quality = _lerp(self.state.quality, q, 0.2)

        return {
            "type": "gaze",
            "x": float(self.state.x),
            "y": float(self.state.y),
            "quality": float(self.state.quality),
            "inferenceMs": float(getattr(self.backend, "ema_infer_ms", 0.0) or 0.0),
        }


def _backend_hello(backend) -> dict:
    """Build the hello handshake payload describing the live backend."""
    desc = backend.describe() if hasattr(backend, "describe") else {"type": "unknown"}
    return {
        "type": "hello",
        "protocol": 1,
        "backend": desc.get("type", "unknown"),
        "device": desc.get("device", "unknown"),
        "face_model": desc.get("face_model"),
        "headpose_model": desc.get("headpose_model"),
        "precision": desc.get("precision"),  # FP16 / FP32 / FP16-INT8
        "reason": desc.get("reason"),        # populated when running fallback
        "ts": time.time(),
    }


async def handle_ws(ws: WebSocketServerProtocol, backend, _path: Optional[str] = None) -> None:
    session = BridgeSession(backend)
    logging.info("Client connected: %s", getattr(ws, "remote_address", None))

    # Tell the client immediately which backend + device is actually serving them.
    # The browser surfaces this in the live status pill so demo audiences can
    # see "Intel NPU 3.4ms" instead of an opaque "OpenVINO Bridge" label.
    try:
        await ws.send(json.dumps(_backend_hello(backend)))
    except Exception as e:
        logging.warning("Failed to send hello: %s", e)

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "frame":
                image_url = msg.get("image")
                if not isinstance(image_url, str):
                    continue
                frame = decode_data_url_jpeg(image_url)
                if frame is None:
                    continue
                gaze = session.process_frame(frame)
                if gaze:
                    await ws.send(json.dumps(gaze))
            elif mtype == "ping":
                # Lightweight liveness check used by the auto-probe in the UI.
                await ws.send(json.dumps({"type": "pong", "ts": time.time()}))
            # Ignore unknown message types silently for forward-compat.
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        logging.info("Client disconnected")


def _parse_device_chain(s: str) -> list:
    """Parse '--device' arg. AUTO expands to NPU, GPU, CPU. Comma list also OK."""
    if not s:
        return ["NPU", "GPU", "CPU"]
    s = s.strip().upper()
    if s == "AUTO":
        return ["NPU", "GPU", "CPU"]
    return [d.strip() for d in s.split(",") if d.strip()]


def make_backend(args):
    face_xml = args.face_model
    head_xml = args.headpose_model
    chain = _parse_device_chain(args.device)

    # Query OpenVINO devices once up-front so the precision picker can match
    # weights to the device the chain will actually pick at compile time.
    ov_devices = []
    if Core is not None:
        try:
            ov_devices = sorted(Core().available_devices)
            logging.info("OpenVINO available_devices = %s", ov_devices)
            if "NPU" in chain and "NPU" not in ov_devices:
                logging.warning(
                    "NPU requested but not in available_devices. "
                    "Check Intel NPU driver install: "
                    "https://www.intel.com/content/www/us/en/support/products/229751/processors.html"
                )
        except Exception as e:
            logging.warning("Could not query OpenVINO devices: %s", e)

    # If user passed explicit paths, respect them verbatim. Otherwise auto-
    # discover and pick the precision that matches the planned device.
    if not face_xml or not head_xml:
        bundled = _autodiscover_models()
        if bundled:
            picked = _pick_precision(list(bundled.keys()), ov_devices, chain)
            if picked and picked in bundled:
                f, h = bundled[picked]
                face_xml = face_xml or f
                head_xml = head_xml or h
                logging.info(
                    "Auto-discovered bundled models | precision=%s (chosen for chain=%s, devices=%s) "
                    "face=%s head=%s",
                    picked, chain, ov_devices, face_xml, head_xml,
                )
            else:
                logging.warning(
                    "Bundled models found but no precision matched device chain %s "
                    "(available precisions: %s).", chain, list(bundled.keys()),
                )

    if face_xml and head_xml:
        try:
            return OpenVinoHeadPoseBackend(face_xml, head_xml, chain)
        except Exception as e:
            logging.warning("OpenVINO init failed, fallback to OpenCV: %s", e)
    else:
        # Loud, single-line warning so booth presenters know why they're seeing
        # the OpenCV pill instead of the NPU pill. The previous silence here
        # was the source of the "OpenVINO Bridge claims acceleration that
        # isn't running" complaint in the May 9 executive summary.
        logging.warning(
            "No OpenVINO models supplied (--face-model + --headpose-model) "
            "and none found under %s — using OpenCV Haar cascade fallback. "
            "The browser will display 'OpenCV (no AI accel)'.",
            os.path.abspath(_BUNDLED_MODELS_DIR),
        )
    return OpenCvFaceCenterBackend()


async def main_async(args) -> None:
    backend = make_backend(args)
    stop = asyncio.Future()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set_result, None)
        except NotImplementedError:
            pass

    async def ws_handler(*handler_args):
        # websockets changed handler signatures across versions:
        # older releases call handler(ws, path), newer call handler(ws).
        ws = handler_args[0] if handler_args else None
        path = handler_args[1] if len(handler_args) > 1 else None
        if ws is None:
            return
        await handle_ws(ws, backend, path)

    async with websockets.serve(
        ws_handler,
        args.host,
        args.port,
        max_size=2**22,
        ping_interval=20,
        ping_timeout=20,
    ):
        logging.info("OpenVINO bridge listening on ws://%s:%s", args.host, args.port)
        await stop


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument(
        "--device",
        default="AUTO",
        help="Device chain. 'AUTO' tries NPU, GPU, CPU in order. "
             "Use a comma list to override: e.g. 'NPU,CPU' or just 'GPU'.",
    )
    p.add_argument("--face-model", default=os.environ.get("OV_FACE_MODEL", ""))
    p.add_argument("--headpose-model", default=os.environ.get("OV_HEADPOSE_MODEL", ""))
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main():
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="[%(asctime)s] %(levelname)s %(message)s",
    )
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
