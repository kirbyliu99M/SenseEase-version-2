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

# OpenVINO 2025 dropped the `openvino.runtime` namespace and exports `Core`
# directly from the top-level `openvino` package. Earlier 2023/2024 builds
# still ship `openvino.runtime`. Try both so a single requirements range
# works across the install base.
Core = None
try:
    from openvino import Core  # type: ignore  # 2024+ / 2025
except Exception:
    try:
        from openvino.runtime import Core  # type: ignore  # 2023.x and some 2024
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
_LANDMARKS_CANDIDATES = [
    "landmarks-regression-retail-0009.xml",
]
_GAZE_CANDIDATES = [
    "gaze-estimation-adas-0002.xml",
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
    """Look for OpenVINO IR sets in the repo's models/ folder, grouped by
    precision. Each precision entry is a dict of model role → xml path:

        {"FP16": {"face": ..., "head": ..., "landmarks": ..., "gaze": ...}, ...}

    Roles "landmarks" and "gaze" may be absent — the server falls back to the
    head-pose-only backend in that case.

    Three layout styles supported, in order of preference:

      1) Per-precision subfolders:
           models/FP16/face-detection-adas-0001.xml
           models/FP32/head-pose-estimation-adas-0001.xml
           models/FP16/landmarks-regression-retail-0009.xml
           models/FP16/gaze-estimation-adas-0002.xml

      2) omz_downloader native nesting:
           models/intel/face-detection-adas-0001/FP16/...
           models/intel/head-pose-estimation-adas-0001/FP32/...
           models/intel/landmarks-regression-retail-0009/FP16/...
           models/intel/gaze-estimation-adas-0002/FP16/...

      3) Flat (legacy face + head only): treated as FP16.
    """
    result: dict = {}
    if not os.path.isdir(_BUNDLED_MODELS_DIR):
        return result

    role_candidates = {
        "face": _FACE_CANDIDATES,
        "head": _HEAD_CANDIDATES,
        "landmarks": _LANDMARKS_CANDIDATES,
        "gaze": _GAZE_CANDIDATES,
    }

    # Style 1: per-precision subfolders directly under models/
    for precision in ("FP16", "FP32", "FP16-INT8"):
        sub = os.path.join(_BUNDLED_MODELS_DIR, precision)
        roles = {role: _find_in_dir(sub, cand) for role, cand in role_candidates.items()}
        # Need at least face + head to be useful at all.
        if roles["face"] and roles["head"]:
            result[precision] = {k: v for k, v in roles.items() if v}

    # Style 2: omz_downloader nesting (models/intel/<model>/<precision>/...)
    intel_dir = os.path.join(_BUNDLED_MODELS_DIR, "intel")
    if os.path.isdir(intel_dir):
        for precision in ("FP16", "FP32", "FP16-INT8"):
            if precision in result:
                continue  # style 1 already won
            roles_found = {}
            for role, cand_list in role_candidates.items():
                for name in cand_list:
                    base = name.replace(".xml", "")
                    cand = os.path.join(intel_dir, base, precision, name)
                    if os.path.isfile(cand):
                        roles_found[role] = cand
                        break
            if roles_found.get("face") and roles_found.get("head"):
                result[precision] = roles_found

    # Style 3: flat fallback. face + head only, treated as FP16.
    if "FP16" not in result and "FP32" not in result:
        face = _find_in_dir(_BUNDLED_MODELS_DIR, _FACE_CANDIDATES)
        head = _find_in_dir(_BUNDLED_MODELS_DIR, _HEAD_CANDIDATES)
        landmarks = _find_in_dir(_BUNDLED_MODELS_DIR, _LANDMARKS_CANDIDATES)
        gaze = _find_in_dir(_BUNDLED_MODELS_DIR, _GAZE_CANDIDATES)
        if face and head:
            entry = {"face": face, "head": head}
            if landmarks: entry["landmarks"] = landmarks
            if gaze: entry["gaze"] = gaze
            result["FP16"] = entry

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


# Magic byte at offset 0 of binary frames, per the v1 binary protocol.
# Lets the server accept either legacy JSON-text frames (older clients) or
# the new zero-base64 binary path. Binary saves ~30% main-thread time on
# the browser side and skips a JSON parse on the server side.
_BIN_FRAME_MAGIC = 0xE1
_BIN_HEADER_LEN = 16  # u8 magic, u8 version, u16 w, u16 h, u8 res*2, f64 ts


def decode_binary_frame(buf: bytes) -> Optional[np.ndarray]:
    if len(buf) <= _BIN_HEADER_LEN:
        return None
    if buf[0] != _BIN_FRAME_MAGIC:
        return None
    jpeg_bytes = buf[_BIN_HEADER_LEN:]
    arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


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
            # Lowered 0.55 -> 0.45 to match the MediaPipe path threshold and
            # to handle the lossy 240x180 JPEG round-trip. Higher numbers
            # rejected too aggressively under typical booth lighting.
            if conf < 0.45:
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
            "pipeline": "head-pose",
            "device": self.actual_device,
            "face_model": self.face_model_name,
            "headpose_model": self.head_model_name,
            "precision": precision,
        }


class OpenVinoEyeGazeBackend:
    """Full OpenVINO eye-gaze pipeline.

    Pipeline:
      face-detection-adas-0001 → face bbox
      landmarks-regression-retail-0009 → 5 face landmarks (incl. eye centers)
      head-pose-estimation-adas-0001 → yaw/pitch/roll
      gaze-estimation-adas-0002 → 3D gaze vector from [left_eye, right_eye, head_angles]

    Returns a normalized gaze vector projected to (gx, gy) ∈ roughly [-1, 1].
    The CLIENT applies its own quadratic mapping calibration to translate
    gaze vectors to screen coordinates — the server intentionally does NOT
    return screen coords, because mapping requires per-user calibration.

    Reference: https://docs.openvino.ai/2024/omz_models_model_gaze_estimation_adas_0002.html
    """

    def __init__(
        self,
        face_xml: str,
        landmarks_xml: str,
        head_xml: str,
        gaze_xml: str,
        device_chain: Optional[list] = None,
    ):
        if Core is None:
            raise RuntimeError("openvino is not installed")

        self.core = Core()
        chain = device_chain or ["NPU", "GPU", "CPU"]
        available = set(self.core.available_devices)
        logging.info(
            "[EyeGaze] Available devices = %s, chain = %s",
            sorted(available), chain,
        )

        last_err = None
        compiled_device = None
        models_to_compile = {
            "face": (face_xml, None),
            "landmarks": (landmarks_xml, None),
            "head": (head_xml, None),
            "gaze": (gaze_xml, None),
        }
        for candidate in chain:
            if candidate not in available and not candidate.startswith("AUTO"):
                logging.info("[EyeGaze] Skipping device %s (not available)", candidate)
                continue
            try:
                logging.info("[EyeGaze] Compiling 4-model pipeline on device=%s", candidate)
                compiled_models = {}
                for role, (path, _) in models_to_compile.items():
                    model = self.core.read_model(path)
                    compiled_models[role] = self.core.compile_model(model, candidate)
                self.face_compiled = compiled_models["face"]
                self.landmarks_compiled = compiled_models["landmarks"]
                self.head_compiled = compiled_models["head"]
                self.gaze_compiled = compiled_models["gaze"]
                self.actual_device = candidate
                compiled_device = candidate
                break
            except Exception as e:
                last_err = e
                logging.warning("[EyeGaze] Compile on %s failed: %s — trying next", candidate, e)
                continue

        if compiled_device is None:
            raise RuntimeError(
                f"Could not compile eye-gaze pipeline on any of {chain}. Last error: {last_err}"
            )

        # Cache i/o handles for hot path.
        self.face_input = self.face_compiled.input(0)
        self.face_output = self.face_compiled.output(0)
        _, _, self.face_h, self.face_w = self.face_input.shape

        self.landmarks_input = self.landmarks_compiled.input(0)
        self.landmarks_output = self.landmarks_compiled.output(0)
        _, _, self.lm_h, self.lm_w = self.landmarks_input.shape

        self.head_input = self.head_compiled.input(0)
        _, _, self.head_h, self.head_w = self.head_input.shape
        self.head_output_names = [o.get_any_name() for o in self.head_compiled.outputs]

        # gaze model has 3 named inputs: head_pose_angles, left_eye_image, right_eye_image
        self.gaze_inputs = {i.get_any_name(): i for i in self.gaze_compiled.inputs}
        self.gaze_output = self.gaze_compiled.output(0)
        # Eye crop input shape — typically [1, 3, 60, 60].
        eye_input = self.gaze_inputs.get("left_eye_image") or list(self.gaze_inputs.values())[0]
        _, _, self.eye_h, self.eye_w = eye_input.shape

        self.last_infer_ms = 0.0
        self.ema_infer_ms = 0.0
        self.face_model_path = face_xml
        self.face_model_name = os.path.basename(face_xml)
        self.landmarks_model_name = os.path.basename(landmarks_xml)
        self.head_model_name = os.path.basename(head_xml)
        self.gaze_model_name = os.path.basename(gaze_xml)

        logging.info(
            "[EyeGaze] Backend ready | device=%s | face=%s lm=%s head=%s gaze=%s",
            self.actual_device,
            self.face_model_name,
            self.landmarks_model_name,
            self.head_model_name,
            self.gaze_model_name,
        )

    @staticmethod
    def _blob_from_bgr(img: np.ndarray, w: int, h: int) -> np.ndarray:
        resized = cv2.resize(img, (w, h), interpolation=cv2.INTER_LINEAR)
        return resized.transpose(2, 0, 1)[np.newaxis, :].astype(np.float32)

    @staticmethod
    def _pick_largest_face(dets: np.ndarray, fw: int, fh: int) -> Optional[Tuple[int, int, int, int, float]]:
        best = None
        best_area = 0.0
        for d in dets.reshape(-1, 7):
            conf = float(d[2])
            if conf < 0.45:
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

    def _crop_eye(self, face_crop: np.ndarray, eye_xy: Tuple[float, float]) -> Optional[np.ndarray]:
        """Crop a square eye patch around the landmark-predicted eye center.
        eye_xy is in face-crop-normalized coords [0,1]."""
        fh, fw = face_crop.shape[:2]
        ex = int(_clamp(eye_xy[0], 0.0, 1.0) * fw)
        ey = int(_clamp(eye_xy[1], 0.0, 1.0) * fh)
        # Square crop sized to ~0.30 × face width — empirically catches
        # the orbital region without too much background.
        half = max(self.eye_w // 2, int(0.15 * fw))
        x1 = max(0, ex - half)
        y1 = max(0, ey - half)
        x2 = min(fw - 1, ex + half)
        y2 = min(fh - 1, ey + half)
        if x2 <= x1 or y2 <= y1:
            return None
        crop = face_crop[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        return crop

    def estimate(self, frame_bgr: np.ndarray) -> Optional[Tuple[float, float, float]]:
        fh, fw = frame_bgr.shape[:2]
        infer_start = time.perf_counter()

        # 1. Face detection
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

        # Pad the face crop so landmarks have context.
        pad = int(0.15 * max(x2 - x1, y2 - y1))
        x1p = max(0, x1 - pad)
        y1p = max(0, y1 - pad)
        x2p = min(fw - 1, x2 + pad)
        y2p = min(fh - 1, y2 + pad)
        face_crop = frame_bgr[y1p:y2p, x1p:x2p]
        if face_crop.size == 0:
            return None

        # 2. Landmarks (5 points: r-eye, l-eye, nose, r-mouth, l-mouth, normalized)
        lm_blob = self._blob_from_bgr(face_crop, self.lm_w, self.lm_h)
        lm_out = self.landmarks_compiled([lm_blob])[self.landmarks_output]
        # Output shape (1, 10, 1, 1) — flatten to 5 (x, y) pairs in face-crop normalized coords.
        flat = np.asarray(lm_out).reshape(-1)
        if flat.size < 4:
            return None
        # Convention: index 0/1 = right eye (camera's right = user's left), 2/3 = left eye.
        right_eye = (float(flat[0]), float(flat[1]))
        left_eye = (float(flat[2]), float(flat[3]))

        # 3. Head pose (yaw, pitch, roll) on face crop
        head_blob = self._blob_from_bgr(face_crop, self.head_w, self.head_h)
        head_out = self.head_compiled([head_blob])
        yaw = pitch = roll = 0.0
        for name in self.head_output_names:
            val = float(np.squeeze(head_out[name]))
            n = name.lower()
            if "angle_y" in n: yaw = val
            elif "angle_p" in n: pitch = val
            elif "angle_r" in n: roll = val

        # 4. Crop eye patches
        right_eye_crop = self._crop_eye(face_crop, right_eye)
        left_eye_crop = self._crop_eye(face_crop, left_eye)
        if right_eye_crop is None or left_eye_crop is None:
            return None

        # 5. Gaze estimation
        # Inputs: head_pose_angles [1,3] (yaw/pitch/roll), left_eye [1,3,60,60], right_eye [1,3,60,60]
        gaze_input = {
            "head_pose_angles": np.array([[yaw, pitch, roll]], dtype=np.float32),
            "left_eye_image": self._blob_from_bgr(left_eye_crop, self.eye_w, self.eye_h),
            "right_eye_image": self._blob_from_bgr(right_eye_crop, self.eye_w, self.eye_h),
        }
        gaze_vec = np.asarray(self.gaze_compiled(gaze_input)[self.gaze_output]).reshape(-1)
        # gaze_vec: 3D unit vector in head coords.
        # x: right (+) / left (-), y: up (+) / down (-), z: out of screen (+)
        gx = float(gaze_vec[0]) if gaze_vec.size >= 1 else 0.0
        gy = float(gaze_vec[1]) if gaze_vec.size >= 2 else 0.0

        # Negate y so positive = looking down (matches screen-y orientation).
        # Quality scales with face detection confidence.
        quality = _clamp(0.5 + conf * 0.45, 0.0, 1.0)

        self.last_infer_ms = (time.perf_counter() - infer_start) * 1000.0
        self.ema_infer_ms = (
            self.last_infer_ms if self.ema_infer_ms == 0
            else _lerp(self.ema_infer_ms, self.last_infer_ms, 0.2)
        )
        return gx, -gy, quality

    def describe(self) -> dict:
        precision = "?"
        for tag in ("FP16-INT8", "FP16", "FP32"):
            if tag in (self.face_model_path or "").upper():
                precision = tag
                break
        return {
            "type": "openvino",
            "pipeline": "eye-gaze",
            "device": self.actual_device,
            "face_model": self.face_model_name,
            "landmarks_model": self.landmarks_model_name,
            "headpose_model": self.head_model_name,
            "gaze_model": self.gaze_model_name,
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
        self._consecutive_no_face = 0
        self._face_log_throttle = 0  # frames since last warning
        # Eye-gaze backend outputs a gaze *vector* roughly in [-1, 1] where
        # 0 = looking at camera. Head-pose / OpenCV backends output screen-
        # normalized [0, 1]. The decay target and the coord_type advertised
        # to the client both depend on this.
        pipeline = getattr(backend, "describe", lambda: {})().get("pipeline")
        if pipeline == "eye-gaze":
            self._coord_type = "gaze_vec"
            self._decay_target = 0.0
            self.state.x = 0.0
            self.state.y = 0.0
        else:
            self._coord_type = "screen"
            self._decay_target = 0.5

    def process_frame(self, frame: np.ndarray) -> Optional[dict]:
        now = time.perf_counter()
        self.state.update_hz(now)
        est = self.backend.estimate(frame)
        if est is None:
            self._consecutive_no_face += 1
            self._face_log_throttle += 1
            # Log every ~30 dropped frames (≈2.5 s at 12 Hz) so a face
            # rejection storm is visible in the server log without
            # flooding it. Helps booth presenters realize the issue is
            # detection (not network/compute).
            if self._face_log_throttle >= 30:
                logging.warning(
                    "Face not detected for %d consecutive frames — check lighting / camera framing",
                    self._consecutive_no_face,
                )
                self._face_log_throttle = 0
            # graceful decay to neutral, keep output available
            if self.state.ready:
                self.state.x = _lerp(self.state.x, self._decay_target, 0.03)
                self.state.y = _lerp(self.state.y, self._decay_target, 0.03)
                self.state.quality = _lerp(self.state.quality, 0.2, 0.12)
                return {
                    "type": "gaze",
                    "coord_type": self._coord_type,
                    "x": self.state.x,
                    "y": self.state.y,
                    "quality": self.state.quality,
                }
            return None
        # Recovery message — single line so the operator sees the moment
        # detection comes back.
        if self._consecutive_no_face >= 30:
            logging.info(
                "Face detection recovered after %d frames",
                self._consecutive_no_face,
            )
        self._consecutive_no_face = 0
        self._face_log_throttle = 0

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
            "coord_type": self._coord_type,
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
        "protocol": 2,  # bumped: pipeline + landmarks/gaze fields
        "backend": desc.get("type", "unknown"),
        "pipeline": desc.get("pipeline"),    # "eye-gaze" | "head-pose" | None (opencv)
        "device": desc.get("device", "unknown"),
        "face_model": desc.get("face_model"),
        "headpose_model": desc.get("headpose_model"),
        "landmarks_model": desc.get("landmarks_model"),
        "gaze_model": desc.get("gaze_model"),
        "precision": desc.get("precision"),
        "reason": desc.get("reason"),
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
            # Binary frame path — preferred. Detected by the magic byte at
            # offset 0, so we don't need a separate WS subprotocol.
            if isinstance(raw, (bytes, bytearray)):
                if len(raw) > 0 and raw[0] == _BIN_FRAME_MAGIC:
                    frame = decode_binary_frame(bytes(raw))
                    if frame is None:
                        continue
                    gaze = session.process_frame(frame)
                    if gaze:
                        await ws.send(json.dumps(gaze))
                continue

            # Legacy JSON-text path — still accepted for backwards
            # compatibility with older clients during a deploy rollover.
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
    landmarks_xml = getattr(args, "landmarks_model", "") or ""
    gaze_xml = getattr(args, "gaze_model", "") or ""
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

    # Auto-discovery returns a dict of role → path per precision. If user
    # passed explicit paths, those take priority verbatim.
    bundled = _autodiscover_models() if (not face_xml or not head_xml) else {}
    chosen_precision = None
    if bundled:
        chosen_precision = _pick_precision(list(bundled.keys()), ov_devices, chain)
        if chosen_precision and chosen_precision in bundled:
            entry = bundled[chosen_precision]
            face_xml = face_xml or entry.get("face")
            head_xml = head_xml or entry.get("head")
            landmarks_xml = landmarks_xml or entry.get("landmarks", "")
            gaze_xml = gaze_xml or entry.get("gaze", "")
            logging.info(
                "Auto-discovered bundled models | precision=%s | chain=%s | devices=%s | "
                "face=%s head=%s landmarks=%s gaze=%s",
                chosen_precision, chain, ov_devices,
                os.path.basename(face_xml or ""),
                os.path.basename(head_xml or ""),
                os.path.basename(landmarks_xml or "") or "(missing)",
                os.path.basename(gaze_xml or "") or "(missing)",
            )
        else:
            logging.warning(
                "Bundled models found but no precision matched device chain %s "
                "(available precisions: %s).", chain, list(bundled.keys()),
            )

    # Preferred path: full eye-gaze pipeline (4 models). The actual NPU
    # demo story rests on this one — head pose alone is a head tracker, not
    # gaze, and the booth narrative needs gaze.
    if face_xml and head_xml and landmarks_xml and gaze_xml:
        try:
            logging.info("Constructing eye-gaze backend (4-model pipeline)")
            return OpenVinoEyeGazeBackend(face_xml, landmarks_xml, head_xml, gaze_xml, chain)
        except Exception as e:
            logging.warning("Eye-gaze backend init failed, falling back: %s", e)

    # Fallback: head-pose-only (2 models). Useful when landmarks/gaze are
    # missing — still drives the mask but tracks head turns, not eye gaze.
    if face_xml and head_xml:
        try:
            logging.info(
                "Constructing head-pose backend (2-model pipeline) — "
                "landmarks-regression-retail-0009 + gaze-estimation-adas-0002 "
                "missing or not auto-discovered. Drop them in models/ for full "
                "eye-gaze accuracy."
            )
            return OpenVinoHeadPoseBackend(face_xml, head_xml, chain)
        except Exception as e:
            logging.warning("OpenVINO init failed, fallback to OpenCV: %s", e)
    else:
        # Loud, single-line warning so booth presenters know why they're seeing
        # the OpenCV pill instead of the NPU pill.
        logging.warning(
            "No OpenVINO models supplied and none found under %s — using "
            "OpenCV Haar cascade fallback. The browser will display "
            "'OpenCV (no AI accel)'.",
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
    p.add_argument("--landmarks-model", default=os.environ.get("OV_LANDMARKS_MODEL", ""),
                   help="landmarks-regression-retail-0009.xml — required for full eye-gaze pipeline")
    p.add_argument("--gaze-model", default=os.environ.get("OV_GAZE_MODEL", ""),
                   help="gaze-estimation-adas-0002.xml — required for full eye-gaze pipeline")
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
