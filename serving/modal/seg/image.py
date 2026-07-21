import modal

"""
Modal image for the ML gap-closing segmentation service
(serving/modal/seg/gap_close_v1_stub.py).

Includes PyTorch + Lightning + the gap_closing module dependencies.
"""


gap_closer_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        # Core dependencies
        "opencv-python-headless",
        "numpy<2",
        "Pillow>=9.0.0",
        "scipy>=1.10.1",
        "tiler==0.5.7",
        "matplotlib==3.7.1",
        "fastapi[standard]",
        "albumentations>=2.0.6",
        "scikit-image>=0.19.0",
        "tqdm>=4.64.0",
        "rich>=13.0.0",
        "argparse>=1.0.0",
        "typing-extensions>=4.0.0",
        # PyTorch and ML dependencies
        "torch>=2.0.0",
        "torchvision>=0.15.0",
        "pytorch-lightning>=2.0.0",
        "torchmetrics>=0.11.0",
    )
    .apt_install(
        "libgl1-mesa-glx",
        "ffmpeg",
        "libsm6",
        "libxext6",
    )
    .add_local_python_source("segmentation")
    .add_local_python_source("serving")
)
