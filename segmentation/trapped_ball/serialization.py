from typing import *
import os
import time
import tempfile
import base64
from io import BytesIO

from PIL import Image
import cv2
import numpy as np


def save_to_temp_dir(image: np.ndarray) -> str:
    temp_dir = tempfile.gettempdir()
    temp_path = os.path.join(temp_dir, f"tempfile{time.time()}.png")
    cv2.imwrite(temp_path, image)
    return temp_path


def img_to_base64_png_uri(img: np.ndarray, url_safe: bool = False) -> str:
    img_uri = img_to_base64_bytes(img, url_safe).decode('utf-8')
    img_uri_with_prefix = f'data:image/png;base64,{img_uri}'
    return img_uri_with_prefix


def img_to_base64_png_uri_pil(img: np.ndarray, url_safe: bool = False) -> str:
    """Channel-order-preserving counterpart of ``img_to_base64_png_uri``.

    ``img_to_base64_png_uri`` writes via ``cv2.imwrite``, which interprets the
    array as BGR(A) — encoding an RGB(A)-ordered render through it silently
    swaps the R/B channels (the mirror image of the decode-side pitfall that
    ``base64_png_uri_to_img_pil`` exists for). Grayscale images are unaffected,
    so the cv2 encoder is fine for segment-id maps; use this one for anything
    rendered in RGB(A) order (e.g. the /preprocess filled reference image).
    """
    buf = BytesIO()
    Image.fromarray(img).save(buf, format='PNG')
    encode_func = base64.urlsafe_b64encode if url_safe else base64.b64encode
    img_uri = encode_func(buf.getvalue()).decode('utf-8')
    return f'data:image/png;base64,{img_uri}'


def img_to_base64_bytes(img: np.ndarray, url_safe: bool = False) -> bytes:
    temp_path = save_to_temp_dir(img)
    if url_safe:
        img_uri = base64.urlsafe_b64encode(open(temp_path, "rb").read())
    else:
        img_uri = base64.b64encode(open(temp_path, "rb").read())
    return img_uri


def base64_png_uri_to_img(img_uri: str, is_url_safe: bool = False) -> np.ndarray:
    if img_uri.startswith("data:"):
        img_uri = img_uri.split(',')[1]

    decode_func = base64.urlsafe_b64decode if is_url_safe else base64.b64decode
    img_bytes = decode_func(img_uri)

    img_array = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_UNCHANGED).astype('uint8')
    
    return img


def base64_png_uri_to_img_pil(img_uri: str | bytes, is_url_safe: bool = False) -> np.ndarray:
    """Alternative to base64_png_uri_to_img using PIL instead of cv2.imdecode."""
    if isinstance(img_uri, bytes):
        img_uri = img_uri.decode('utf-8')
    
    if img_uri.startswith("data:"):
        img_uri = img_uri.split(',')[1]

    decode_func = base64.urlsafe_b64decode if is_url_safe else base64.b64decode
    img_bytes = decode_func(img_uri)

    pil_img = Image.open(BytesIO(img_bytes))
    img = np.array(pil_img)
    
    return img


def int32_to_rgba(int_arr: np.ndarray) -> np.ndarray:
    r = int_arr // (256 ** 3)
    g = (int_arr % (256 ** 3)) // (256 ** 2)
    b = ((int_arr % (256 ** 3 )) % (256 ** 2)) // 256
    a = (((int_arr % (256 ** 3)) % (256 ** 2)) % 256) 
    r = r.astype(np.uint8)
    g = g.astype(np.uint8)
    b = b.astype(np.uint8)
    a = a.astype(np.uint8)
    return np.stack([r, g, b, a], axis=-1)


def int32_to_rgba_with_padding(int_arr: np.ndarray) -> np.ndarray:
    rgba = int32_to_rgba(int_arr)
    # we will never have this many segs, so we can use the max value to represent padding
    rgba[int_arr == -100] = [255, 255, 255, 255]  # max int32 value represented in RGBA
    return rgba


def rgba_to_int32(rgba_arr: np.ndarray, dtype = np.uint32) -> np.ndarray:
    rgba_arr = rgba_arr.astype(dtype)
    r = rgba_arr[:, :, 0]
    g = rgba_arr[:, :, 1]
    b = rgba_arr[:, :, 2]
    a = rgba_arr[:, :, 3]
    int_arr = (256 * 256 * 256 * r) + (256 * 256 * g) + (256 * b) + a
    return int_arr


def borders_cache_to_rgba(borders_cache: Dict[str, np.ndarray]) -> np.ndarray:
    vert_borders = [borders_cache["bottom_border"], borders_cache["top_border"]]
    vert_borders_arr = np.concatenate([(arr + 1) for arr in vert_borders], axis=0)
    horiz_borders = [borders_cache["left_border"], borders_cache["right_border"]]
    horiz_borders_arr = np.concatenate([(arr + 1) for arr in horiz_borders], axis=0)
    return int32_to_rgba(vert_borders_arr), int32_to_rgba(horiz_borders_arr)


def borders_cache_from_rgba(vert_rgba: np.ndarray, horiz_rgba: np.ndarray) -> np.ndarray:
    vert_arr = rgba_to_int32(vert_rgba) - 1
    horiz_arr = rgba_to_int32(horiz_rgba) - 1
    return {
        "bottom_border": vert_arr[0: vert_arr.shape[0] // 2],
        "top_border": vert_arr[vert_arr.shape[0] // 2:],
        "left_border": horiz_arr[0: horiz_arr.shape[0] // 2],
        "right_border": horiz_arr[horiz_arr.shape[0] // 2:],
    }


def save_borders_cache(borders_cache: Dict[str, np.ndarray], path: str):
    borders_cache_bytes = borders_cache_to_bytes(borders_cache)
    with open(path, 'wb') as file:
        file.write(borders_cache_bytes)

    
def borders_cache_to_bytes(borders_cache: Dict[str, np.ndarray]):
    vert_border_rgba, horiz_borders_rgba = borders_cache_to_rgba(borders_cache)
    vert_border_png = img_to_base64_bytes(vert_border_rgba, url_safe=True)
    horiz_border_png = img_to_base64_bytes(horiz_borders_rgba, url_safe=True)
    both_png = vert_border_png + b'<SEP>' + horiz_border_png
    return both_png
       
  
def borders_cache_to_uri(borders_cache: Dict[str, np.ndarray]) -> str:
    borders_cache_uri = borders_cache_to_bytes(borders_cache).decode('utf-8')
    return borders_cache_uri
        
        
def read_borders_cache_from_path(path: str) -> Dict[str, np.ndarray]:
    with open(path, 'rb') as file:
        both_png = file.read()
    vert_border_png, horiz_border_png = both_png.split(b'<SEP>')
    vert_border_rgba = base64_png_uri_to_img(vert_border_png, is_url_safe=False)
    horiz_border_rgba = base64_png_uri_to_img(horiz_border_png, is_url_safe=False)
    return borders_cache_from_rgba(vert_border_rgba, horiz_border_rgba)


def read_borders_cache_from_uri(uri: str) -> Dict[str, np.ndarray]:
    vert_uri, horiz_uri = uri.split('<SEP>') 
    vert_border_rgba = base64_png_uri_to_img(vert_uri, is_url_safe=True)
    horiz_border_rgba = base64_png_uri_to_img(horiz_uri, is_url_safe=True)
    return borders_cache_from_rgba(vert_border_rgba, horiz_border_rgba)
