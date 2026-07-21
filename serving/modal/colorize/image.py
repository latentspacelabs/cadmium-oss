import modal


image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.0-devel-ubuntu20.04",
        add_python="3.10",
        setup_dockerfile_commands=[
            "RUN apt update",
            "ENV DEBIAN_FRONTEND=noninteractive",
        ],
    )
    .apt_install(
        "libgl1",
        "libglib2.0-0",
        "build-essential",
        "libopencv-dev",
        "python3-opencv",
        "libgl1-mesa-glx",
        "ffmpeg",
        "libsm6",
        "libxext6",
    )
    .pip_install(
        "albumentations==2.0.6",
        "torch==2.4.1",
        "torchvision==0.19.1",
        "transformers==4.46.3",
        "einops==0.8.0",
        "pillow==9.1.1",
        "scipy==1.14.1",
        "numpy==2.1.3",
        "matplotlib==3.9.2",
        "opencv-python==4.10.0.84",
        "opencv-python-headless==4.10.0.84",
        "comet-ml==3.47.6",
        "torch-geometric==2.6.1",
        "scikit-image==0.24.0",
        "CairoSVG==2.7.1",
        "kornia==0.7.3",
        "cupy-cuda12x==13.3.0",
        "cucim-cu12==24.10.0",
        "https://github.com/latentspacelabs/vtracer/releases/download/cmdapp.2025.2.17/vtracer-0.6.16-cp310-cp310-linux_x86_64.whl",
        "scikit-learn",
        "datasets",
        "python-dotenv",
        "fastapi[standard]",
    )
    .pip_install(
        "torch_scatter==2.1.2+pt24cu121",
        find_links="https://data.pyg.org/whl/torch-2.4.1+cu121.html"
    )
    .run_commands(
        "nvcc --version",
        "pip install cupy-cuda12x==13.3.0",
        "pip install cucim-cu12==24.10.0",
        gpu="A10G",
    )
    .add_local_python_source("colorize")
    .add_local_python_source("segmentation")
    .add_local_python_source("serving")
)
