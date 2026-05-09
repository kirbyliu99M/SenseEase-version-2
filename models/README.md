# OpenVINO Models — Bundled via Git LFS

This folder ships the OpenVINO IR (`.xml` + `.bin`) files for the gaze
bridge. Both **FP16** and **FP32** precisions are bundled so the bridge
can pick the right weights for whichever device wins the AUTO chain:

| Device picked  | Precision used | Why |
|----------------|---------------|-----|
| Intel **NPU**  | FP16          | NPU spec; FP32 won't even compile on Meteor Lake / Lunar Lake NPU |
| Intel **GPU**  | FP32          | Wider op coverage on iGPU; FP16 also works but FP32 is more stable |
| **CPU**        | FP32          | Same as GPU; FP32 has no perf penalty on modern CPUs at this model size |

The picker is in `tools/openvino_bridge_server.py::_pick_precision()`.
Browser status pill displays the chosen precision (e.g., `Intel NPU · FP16 · 3.4 ms`).

## Bundled folder layouts

The bridge accepts three layouts and picks the first one it finds:

### Layout 1 — flat per-precision (recommended, smallest path):

```
models/
├── FP16/
│   ├── face-detection-adas-0001.xml
│   ├── face-detection-adas-0001.bin
│   ├── head-pose-estimation-adas-0001.xml
│   └── head-pose-estimation-adas-0001.bin
└── FP32/
    ├── face-detection-adas-0001.xml
    ├── face-detection-adas-0001.bin
    ├── head-pose-estimation-adas-0001.xml
    └── head-pose-estimation-adas-0001.bin
```

### Layout 2 — `omz_downloader` native (no flatten step needed):

```
models/intel/
├── face-detection-adas-0001/
│   ├── FP16/...
│   └── FP32/...
└── head-pose-estimation-adas-0001/
    ├── FP16/...
    └── FP32/...
```

### Layout 3 — flat (legacy, single precision; treated as FP16):

```
models/
├── face-detection-adas-0001.xml
├── face-detection-adas-0001.bin
├── head-pose-estimation-adas-0001.xml
└── head-pose-estimation-adas-0001.bin
```

## First-time setup (per machine)

You need **Git LFS** installed before cloning, otherwise the `.bin`/`.xml`
files arrive as small text pointers instead of real model weights.

```powershell
# 1. Install Git LFS once per machine
git lfs version  # check first; install from https://git-lfs.com/ if missing
git lfs install

# 2. Clone or pull as normal — LFS objects download automatically
git clone https://github.com/kirbyliu99M/SenseEase-version-2.git
# (or `git lfs pull` if you cloned before installing LFS)
```

## Populating the models folder (one-time per repo)

Use Intel's `omz_downloader` to grab both precisions in one go:

```powershell
pip install openvino-dev
omz_downloader --name face-detection-adas-0001 --output_dir ./models --precisions FP16,FP32
omz_downloader --name head-pose-estimation-adas-0001 --output_dir ./models --precisions FP16,FP32
```

This produces Layout 2 (`models/intel/.../FP16/...`), which the bridge reads
as-is. If you prefer Layout 1 (flatter), move them up:

```powershell
New-Item -ItemType Directory -Force ./models/FP16, ./models/FP32 | Out-Null
Move-Item ./models/intel/face-detection-adas-0001/FP16/* ./models/FP16/
Move-Item ./models/intel/face-detection-adas-0001/FP32/* ./models/FP32/
Move-Item ./models/intel/head-pose-estimation-adas-0001/FP16/* ./models/FP16/
Move-Item ./models/intel/head-pose-estimation-adas-0001/FP32/* ./models/FP32/
Remove-Item -Recurse ./models/intel
```

## Updating the models

Drop the new files in the appropriate precision folder and commit:

```powershell
git add models/
git commit -m "Update OpenVINO models"
git push
```

Verify LFS picked them up (not committed as raw binaries):

```powershell
git lfs ls-files
```

## Falling back without models

If LFS files didn't download (e.g., `GIT_LFS_SKIP_SMUDGE=1` was set), the
bridge logs a warning and falls back to OpenCV Haar cascade. Browser pill
shows `OpenCV (no AI accel)` so demo audiences see the OpenVINO path is off.

## License & origin

These are Intel Open Model Zoo models (Apache 2.0). Canonical mirror:
https://storage.openvinotoolkit.org/repositories/open_model_zoo/
