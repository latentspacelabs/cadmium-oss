import modal


v2_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "opencv-python==4.7.0.72",
        "altgraph==0.17",
        "future==0.18.2",
        "multipledispatch==0.6.0",
        "numpy",
        "pefile==2021.5.24",
        "Pillow",
        "PyInstaller==4.4",
        "PyQt5==5.15.4",
        "PyQt5-sip==12.9.0",
        "pyrr==0.10.3",
        "pywin32-ctypes==0.2.0",
        "six==1.16.0",
        "scipy==1.10.1",
        "tiler==0.5.7",
        "matplotlib==3.7.1",
        "fastapi[standard]",
        "torch==2.4.1",
        "scikit-image==0.24.0",
        "psutil"
    )
    .apt_install(
        "libgl1-mesa-glx",
        "ffmpeg",
        "libsm6",
        "libxext6",
    )
    .add_local_python_source("colorize")
    .add_local_python_source("segmentation")
    .add_local_python_source("serving")
)
