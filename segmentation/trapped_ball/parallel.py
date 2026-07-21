from typing import *
import concurrent.futures
import multiprocessing
import functools
import numpy as np
import time
import random
import copy

from segmentation.trapped_ball.trapped_ball import compute_seg_fast
from tiler import Tiler, Merger
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


# TODO: combine with other function
def _seg_worker(tile_data, tb_sizes, max_iter, min_seg_size):
    tile_id, tile = tile_data
    # TODO: check for > 256 segs in compute_seg 
    start = time.time()
    seg = compute_seg_fast(tile, tb_sizes, max_iter, min_seg_size)
    # seg = np.zeros_like(tile)
    print(f'Time taken to seg tile {tile_id}: {time.time() - start} sec')
    return tile_id, seg


def compute_seg_tiles(tiles_to_seg, tb_sizes, max_iter, min_seg_size, num_workers=None):
    num_cpus = multiprocessing.cpu_count() 
    if num_workers is None or num_workers > num_cpus:
        num_workers = num_cpus
    print(f'NUM_WORKERS: {num_workers} NUM_CPUS: {num_cpus}')
    
    new_tile_data = []
    with concurrent.futures.ProcessPoolExecutor(max_workers=num_workers) as executor:
        seg_worker = functools.partial(
            _seg_worker, tb_sizes=tb_sizes, max_iter=max_iter, min_seg_size=min_seg_size)

        for (tile_id, processed_tile) in executor.map(seg_worker, tiles_to_seg):
            _tile = processed_tile 
            # new_tile_data.append((tile_id, _tile))
            new_tile_data.append((tile_id, _tile + (tile_id * 256)))
            
    return new_tile_data


def build_border_data(
    tiler: Tiler,
    merger: Merger,
    segged_tile_data: List[Tuple[int, np.ndarray]],
    border_h_delta: int,
    border_w_delta: int,
    old_border_data: Dict[str, np.ndarray] = None,
):
    mosaic_shape = tiler.get_mosaic_shape()
    padded_shape = tiler._new_shape
    
    if old_border_data is None:
        # make padding -1 to avoid confusion with segs 
        top_border = np.zeros([mosaic_shape[0], padded_shape[1]], dtype=np.int32) - 1
        bottom_border = np.zeros([mosaic_shape[0], padded_shape[1]], dtype=np.int32) - 1
        left_border = np.zeros([mosaic_shape[1], padded_shape[0]], dtype=np.int32) - 1
        right_border = np.zeros([mosaic_shape[1], padded_shape[0]], dtype=np.int32) - 1
    else:
        top_border = old_border_data["top_border"]
        bottom_border = old_border_data["bottom_border"]
        left_border = old_border_data["left_border"]
        right_border = old_border_data["right_border"]
    
    # top_indices = [[None]] * mosaic_shape[0]
    # bottom_indices = [[None]] * mosaic_shape[0]
    # left_indices = [[None]] * mosaic_shape[1]
    # right_indices = [[None]] * mosaic_shape[1]

    for tile_id, processed_tile in segged_tile_data:
        tile_h = processed_tile.shape[0]
        tile_w = processed_tile.shape[1]
        
        # print(tiler.get_tile(None, tile_id=tile_id))
        tile_bbox = tiler.get_tile_bbox(tile_id, all_corners=True)
        tile_h_start = tile_bbox[0, 0]
        tile_h_end = tile_bbox[2, 0]
        tile_w_start = tile_bbox[0, 1]
        tile_w_end = tile_bbox[1, 1]
        
        mosaic_h, mosaic_w = tiler.get_tile_mosaic_position(tile_id)
        
        top_border[
            mosaic_h,
            tile_w_start + border_w_delta:tile_w_end - border_w_delta,
        ] = processed_tile[border_h_delta, border_w_delta:tile_w - border_w_delta]
        
        # top_indices[mosaic_h].append([
        #     tile_h_start + border_h_delta,
        #     tile_w_start + border_w_delta,
        #     tile_w_end - border_w_delta,
        # ])
        
        bottom_border[
            mosaic_h,
            tile_w_start + border_w_delta:tile_w_end - border_w_delta,
        ] = processed_tile[tile_h - border_h_delta, border_w_delta:tile_w - border_w_delta]
        
        # bottom_indices[mosaic_h].append([
        #     tile_h_end - border_h_delta,
        #     tile_w_start + border_w_delta,
        #     tile_w_end - border_w_delta,
        # ])
        
        left_border[
            mosaic_w,
            tile_h_start + border_h_delta:tile_h_end - border_h_delta,
        ] = processed_tile[border_h_delta:tile_h - border_h_delta, border_w_delta]
        
        # left_indices[mosaic_w].append([
        #     tile_w_start + border_w_delta,
        #     tile_h_start + border_h_delta,
        #     tile_h_end - border_h_delta
        # ])
        
        right_border[
            mosaic_w,
            tile_h_start + border_h_delta:tile_h_end - border_h_delta,
        ] = processed_tile[border_h_delta:tile_h - border_h_delta, tile_w - border_w_delta]
        
        # right_indices[mosaic_w].append([
        #     tile_w_end - border_w_delta,
        #     tile_h_start + border_h_delta,
        #     tile_h_end - border_h_delta
        # ])
         
        merger.add(tile_id, processed_tile)
        
    return bottom_border, top_border, left_border, right_border


def compute_cc(
    bottom_border: np.ndarray,
    top_border: np.ndarray,
    left_border: np.ndarray,
    right_border: np.ndarray,
    border_h_delta: int,
    border_w_delta: int,
    max_seg_id: int,
):
    # trim padding and unused borders
    bottom_border = bottom_border[:-1, border_h_delta:-border_h_delta]
    top_border = top_border[1:, border_h_delta:-border_h_delta]
    left_border = left_border[1:, border_w_delta:-border_w_delta]
    right_border = right_border[:-1, border_w_delta:-border_w_delta]
    
    bottom_border = bottom_border.ravel()
    top_border = top_border.ravel()
    left_border = left_border.ravel()
    right_border = right_border.ravel()
    
    # Build sparse matrix directly from edges (no dense intermediate)
    rows = np.concatenate([bottom_border, left_border])
    cols = np.concatenate([top_border, right_border])
    
    # Filter out padding (-1 values)
    valid = (rows >= 0) & (cols >= 0)
    rows = rows[valid]
    cols = cols[valid]
    data = np.ones(len(rows), dtype=np.int8)
    
    graph = coo_matrix((data, (rows, cols)), shape=(max_seg_id, max_seg_id)).tocsr()
    _, n_labels = connected_components(csgraph=graph, directed=False, return_labels=True)
    
    return n_labels


def compute_seg_full(
    binary: np.ndarray,
    tiler: Tiler,
    merger: Merger,
    padding: List[Tuple[int, int]],
    overlap_factor: float,
    tb_sizes: List[int] = [3,2,1],
    max_iter: int = 10,
    min_seg_size: int = 20,
):
    # tile bookkeeping 
    tile_data = list(tiler(binary))
    num_tiles = len(tile_data)
    max_seg_id = num_tiles * 512
    
    # split overlap distance in half to get connection border
    border_h_delta = int((tiler.tile_shape[0] * overlap_factor) / 2)
    border_w_delta = int((tiler.tile_shape[1] * overlap_factor) / 2)
    
    start = time.time()
    segged_tile_data = compute_seg_tiles(
        tiles_to_seg=tile_data,
        tb_sizes=tb_sizes,
        max_iter=max_iter,
        min_seg_size=min_seg_size,
        num_workers=num_tiles
    )
    print('Time taken to seg {} tiles: {} sec'.format(num_tiles, time.time() - start))
    
    start = time.time()
    bottom_border, top_border, left_border, right_border = build_border_data(
        tiler=tiler,
        merger=merger,
        segged_tile_data=segged_tile_data,
        border_h_delta=border_h_delta,
        border_w_delta=border_w_delta,
    )
    print('Time taken to build borders: {} sec'.format(time.time() - start))
    
    borders_cache = {
        "bottom_border": copy.deepcopy(bottom_border),
        "top_border": copy.deepcopy(top_border),
        "left_border": copy.deepcopy(left_border),
        "right_border": copy.deepcopy(right_border)
    }
    
    # connected components 
    start = time.time()
    n_labels = compute_cc(
        bottom_border=bottom_border,
        top_border=top_border,
        left_border=left_border,
        right_border=right_border,
        border_h_delta=border_h_delta,
        border_w_delta=border_w_delta,
        max_seg_id=max_seg_id,
    )
    print('Time taken for connected components: {} sec'.format(time.time() - start))
    
    # merge step 
    start = time.time()
    unmerged = merger.merge(extra_padding=padding, dtype=np.uint32)
    merged = n_labels[unmerged]
    print('Time taken for final merge: {} sec'.format(time.time() - start))
    
    return merged, unmerged, borders_cache
 

def get_tiles_to_reseg(old_line_tile_data, new_line_tile_data):
    reseg_tiles = []
    for (old_tile_id, old_tile), (new_tile_id, new_tile) in zip(old_line_tile_data, new_line_tile_data):
        assert old_tile_id == new_tile_id, 'tile ids must match'
        differing_pixels = old_tile != new_tile
        if np.sum(differing_pixels) != 0:
            reseg_tiles.append((new_tile_id, new_tile))
    return reseg_tiles


def compute_seg_partial(
    old_binary: np.ndarray,
    new_binary: np.ndarray,
    old_seg_unmerged: np.ndarray,
    old_seg_borders: Dict[str, np.ndarray],
    tiler: Tiler,
    merger: Merger,
    padding: List[Tuple[int, int]],
    overlap_factor: float,
    tb_sizes: List[int] = [3,2,1],
    max_iter: int = 10,
    min_seg_size: int = 20,
):
    # global tile bookkeeping 
    old_line_tile_data = list(tiler(old_binary))
    new_line_tile_data = list(tiler(new_binary))
    num_tiles = len(new_line_tile_data)
    max_seg_id = num_tiles * 256
    
    # split overlap distance in half to get connection border
    border_h_delta = int((tiler.tile_shape[0] * overlap_factor) / 2)
    border_w_delta = int((tiler.tile_shape[1] * overlap_factor) / 2)
    
    start = time.time() 
    new_line_tiles_to_seg = get_tiles_to_reseg(old_line_tile_data, new_line_tile_data)
    print('Time taken to find re-seg tiles: {} sec'.format(time.time() - start))
          
    # reseg_tile_indices = [tile_id for tile_id, _ in new_line_tiles_to_seg]
    if len(new_line_tiles_to_seg) > 0:
        start = time.time() 
        num_reseg_tiles = len(new_line_tiles_to_seg)
        resegged_tiles = compute_seg_tiles(
            tiles_to_seg=new_line_tiles_to_seg,
            tb_sizes=tb_sizes,
            max_iter=max_iter,
            min_seg_size=min_seg_size,
            num_workers=num_reseg_tiles,
        )
        print('Time taken for re-seg {} tiles: {} sec'.format(num_reseg_tiles, time.time() - start))
    else:
        resegged_tiles = []
        print('No tiles found to re-seg, line images are identical')
    
    start = time.time()
    bottom_border, top_border, left_border, right_border = build_border_data(
        tiler=tiler,
        merger=merger,
        segged_tile_data=resegged_tiles,
        border_h_delta=border_h_delta,
        border_w_delta=border_w_delta,
        old_border_data=old_seg_borders,
    )
    print('Time taken to build borders: {} sec'.format(time.time() - start))
    
    borders_cache = {
        "bottom_border": copy.deepcopy(bottom_border),
        "top_border": copy.deepcopy(top_border),
        "left_border": copy.deepcopy(left_border),
        "right_border": copy.deepcopy(right_border)
    }
    
    # connected components 
    start = time.time()
    n_labels = compute_cc(
        bottom_border=bottom_border,
        top_border=top_border,
        left_border=left_border,
        right_border=right_border,
        border_h_delta=border_h_delta,
        border_w_delta=border_w_delta,
        max_seg_id=max_seg_id,
    )
    print('Time taken for connected components: {} sec'.format(time.time() - start))
    
    # merge step 
    start = time.time()
    unmerged = merger.merge(extra_padding=padding, dtype=np.uint32)
    old_seg_unmerged = np.where(unmerged == 0, old_seg_unmerged, 0)
    unmerged = old_seg_unmerged + unmerged
    merged = n_labels[unmerged]
    print('Time taken for final merge: {} sec'.format(time.time() - start))
    
    return merged, unmerged, borders_cache
