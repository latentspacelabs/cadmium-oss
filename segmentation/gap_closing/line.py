from typing import List, Tuple, Dict, Optional
import random
from collections import deque
import numpy as np
import cv2
from skimage.morphology import skeletonize as sk_skeletonize

from segmentation.trapped_ball.cropping import get_bbox_pad_dims, crop_image


def skeletonize(binary_image: np.ndarray) -> np.ndarray:
    """Create skeleton using proper morphological skeletonization.
    
    Args:
        binary_image: Binary image (uint8, 0 or 255)
        
    Returns:
        Skeletonized image (uint8, 0 or 255)
    """
    # Convert to boolean for skimage
    binary_bool = binary_image > 0
    skeleton_bool = sk_skeletonize(binary_bool)
    return (skeleton_bool * 255).astype(np.uint8)


def compute_neighbor_count(skeleton: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Compute neighbor count for each skeleton pixel using 8-connected convolution.
    
    Args:
        skeleton: Binary skeleton (uint8 or float32)
        
    Returns:
        Tuple of (skeleton_binary, neighbor_count):
            - skeleton_binary: Binary skeleton as uint8
            - neighbor_count: Number of neighbors for each pixel
    """
    # Convert to binary uint8
    skeleton_binary = (skeleton > 0.01).astype(np.uint8) if skeleton.dtype != np.uint8 else (skeleton > 0).astype(np.uint8)
    
    # 8-connected neighbor counting kernel
    kernel = np.array([[1, 1, 1],
                      [1, 0, 1], 
                      [1, 1, 1]], dtype=np.uint8)
    
    # Count neighbors using convolution
    neighbor_count = cv2.filter2D(skeleton_binary, -1, kernel)
    
    return skeleton_binary, neighbor_count


def detect_endpoints(
    skeleton: np.ndarray,
    deduplicate: bool = True,
    min_point_distance: int = 3,
    do_skeletonize: bool = False,
    return_distance_map: bool = False,
):
    """Detect endpoint pixels in a skeleton (pixels with exactly 1 neighbor).
    
    Args:
        skeleton: Binary skeleton (uint8 or float32). If do_skeletonize=True, can be a binary image.
        deduplicate: Whether to deduplicate nearby points
        min_point_distance: Minimum distance between deduplicated points
        do_skeletonize: If True, skeletonize the input first before detecting endpoints
        return_distance_map: If True, also return distance transform from endpoints
        
    Returns:
        If return_distance_map=False: List of (y, x) tuples for endpoint locations
        If return_distance_map=True: Tuple of (endpoint_list, distance_map)
    """
    # Optionally skeletonize first
    if do_skeletonize:
        # Ensure binary
        binary = (skeleton > 0.5 if skeleton.max() <= 1.0 else skeleton > 127).astype(np.uint8) * 255
        if binary.sum() == 0:
            if return_distance_map:
                return [], None
            return []
        skeleton = skeletonize(binary)
    
    # Compute neighbor count using shared helper
    skeleton_binary, neighbor_count = compute_neighbor_count(skeleton)
    
    # Endpoints have exactly 1 neighbor
    endpoint_mask = (skeleton_binary > 0) & (neighbor_count == 1)
    endpoint_coords = np.where(endpoint_mask)
    endpoint_list = list(zip(endpoint_coords[0], endpoint_coords[1])) if len(endpoint_coords[0]) > 0 else []
    
    # Deduplicate if requested
    if deduplicate and len(endpoint_list) > 0:
        endpoint_list = deduplicate_points(endpoint_list, min_point_distance)
    
    if return_distance_map:
        # Compute distance transform from endpoints
        if len(endpoint_list) == 0:
            distance_map = None
        else:
            h, w = skeleton.shape
            endpoint_binary = np.ones((h, w), dtype=np.uint8)  # 1 = background
            for ey, ex in endpoint_list:
                endpoint_binary[ey, ex] = 0  # 0 = endpoint
            distance_map = cv2.distanceTransform(endpoint_binary, cv2.DIST_L2, 3)
        return endpoint_list, distance_map
    
    return endpoint_list


def find_corner_points(skeleton: np.ndarray, neighbor_count: np.ndarray) -> np.ndarray:
    """Find corner/angle points where two lines meet at sharp angles.
    
    A corner point is a skeleton pixel with exactly 2 neighbors where the neighbors
    form a significant angle (between 30-150 degrees), not a gentle curve or straight line.
    
    Uses multi-pixel lookahead to distinguish true corners from curved sections.
    
    Args:
        skeleton: Binary skeleton (uint8)
        neighbor_count: Number of neighbors for each pixel
        
    Returns:
        Boolean mask of corner points
    """
    h, w = skeleton.shape
    corner_mask = np.zeros((h, w), dtype=bool)
    
    # Look at pixels with exactly 2 neighbors (potential corners)
    two_neighbor_points = np.where((skeleton > 0) & (neighbor_count == 2))
    
    for y, x in zip(two_neighbor_points[0], two_neighbor_points[1]):
        # Find the 2 neighboring pixels
        neighbors = []
        for dy in [-1, 0, 1]:
            for dx in [-1, 0, 1]:
                if dy == 0 and dx == 0:
                    continue
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and skeleton[ny, nx] > 0:
                    neighbors.append((dy, dx, ny, nx))
        
        # Should have exactly 2 neighbors
        if len(neighbors) != 2:
            continue
        
        # Get immediate neighbor directions
        dy1, dx1, ny1, nx1 = neighbors[0]
        dy2, dx2, ny2, nx2 = neighbors[1]
        
        # STRICT FILTER 1: Check immediate angle
        # Dot product of direction vectors
        dot_product = dy1 * dy2 + dx1 * dx2
        
        # Normalize by magnitudes
        mag1 = np.sqrt(dy1*dy1 + dx1*dx1)
        mag2 = np.sqrt(dy2*dy2 + dx2*dx2)
        normalized_dot = dot_product / (mag1 * mag2)
        
        # Only consider angles between 30-150 degrees
        # cos(30°) ≈ 0.866, cos(150°) ≈ -0.866
        # This filters out: straight lines (180°), gentle curves (>150° or <30°)
        if normalized_dot <= -0.866 or normalized_dot >= 0.866:
            continue
        
        # STRICT FILTER 2: Multi-pixel lookahead to verify it's a true corner
        # Follow each branch for 3-5 pixels and measure the overall direction
        # If it's a gentle curve, the far directions will be more aligned
        
        def trace_branch_direction(start_y, start_x, initial_dy, initial_dx, steps=4):
            """Trace along a branch and return the average direction vector."""
            cy, cx = start_y, start_x
            prev_y, prev_x = y, x  # Start from the center point
            
            for _ in range(steps):
                # Find next pixel along this branch
                found = False
                for search_dy in [-1, 0, 1]:
                    for search_dx in [-1, 0, 1]:
                        if search_dy == 0 and search_dx == 0:
                            continue
                        ny_next = cy + search_dy
                        nx_next = cx + search_dx
                        # Don't go back to previous pixel
                        if ny_next == prev_y and nx_next == prev_x:
                            continue
                        if (0 <= ny_next < h and 0 <= nx_next < w and 
                            skeleton[ny_next, nx_next] > 0):
                            prev_y, prev_x = cy, cx
                            cy, cx = ny_next, nx_next
                            found = True
                            break
                    if found:
                        break
                if not found:
                    break
            
            # Return direction from center to final position
            return (cy - start_y, cx - start_x)
        
        # Get far directions for both branches
        far_dy1, far_dx1 = trace_branch_direction(ny1, nx1, dy1, dx1)
        far_dy2, far_dx2 = trace_branch_direction(ny2, nx2, dy2, dx2)
        
        # If we couldn't trace far enough, skip
        if (far_dy1 == 0 and far_dx1 == 0) or (far_dy2 == 0 and far_dx2 == 0):
            continue
        
        # Measure angle between far directions
        far_dot = far_dy1 * far_dy2 + far_dx1 * far_dx2
        far_mag1 = np.sqrt(far_dy1*far_dy1 + far_dx1*far_dx1)
        far_mag2 = np.sqrt(far_dy2*far_dy2 + far_dx2*far_dx2)
        
        if far_mag1 == 0 or far_mag2 == 0:
            continue
            
        far_normalized_dot = far_dot / (far_mag1 * far_mag2)
        
        # Far angle should also be significant (30-150 degrees)
        # If the far angle is near 180°, it's a gentle curve, not a corner
        if far_normalized_dot <= -0.866 or far_normalized_dot >= 0.866:
            continue
        
        # Passed all filters - this is a true corner!
        corner_mask[y, x] = True
    
    return corner_mask


def deduplicate_points(points_list: List[Tuple[int, int]], min_distance: int = 3) -> List[Tuple[int, int]]:
    """Deduplicate nearby points using Non-Maximum Suppression.
    
    Keeps only one point per local neighborhood to avoid duplicate detections
    on multi-pixel junction regions.
    
    Args:
        points_list: List of (y, x) tuples
        min_distance: Minimum distance between kept points
        
    Returns:
        Deduplicated list of (y, x) tuples
    """
    if len(points_list) == 0:
        return points_list
    
    points = np.array(points_list)
    kept_points = []
    
    while len(points) > 0:
        # Take first point
        current = points[0]
        kept_points.append(tuple(current))
        
        # Remove all points within min_distance
        distances = np.sqrt(np.sum((points - current)**2, axis=1))
        points = points[distances > min_distance]
    
    return kept_points


def detect_skeleton_keypoints(
    skeleton: np.ndarray,
    deduplicate: bool = True,
    min_point_distance: int = 3
) -> Dict[str, List[Tuple[int, int]]]:
    """Detect all keypoints (endpoints, junctions, corners) in a skeleton.
    
    Args:
        skeleton: Binary skeleton image (uint8, 0 or 255)
        deduplicate: Whether to deduplicate nearby points
        min_point_distance: Minimum distance between deduplicated points
        
    Returns:
        Dictionary with keys 'endpoint', 'junction', 'corner', each containing
        a list of (y, x) tuples
    """
    # Check if skeleton is empty
    if (skeleton > 0).sum() == 0:
        return {'endpoint': [], 'junction': [], 'corner': []}
    
    # Compute neighbor count
    skeleton_binary, neighbor_count = compute_neighbor_count(skeleton)
    
    # Endpoints have exactly 1 neighbor
    endpoint_mask = (skeleton_binary > 0) & (neighbor_count == 1)
    endpoint_coords = np.where(endpoint_mask)
    endpoints = list(zip(endpoint_coords[0], endpoint_coords[1])) if len(endpoint_coords[0]) > 0 else []
    
    # Junction points have 3-6 neighbors
    junction_mask = (skeleton_binary > 0) & (neighbor_count >= 3) & (neighbor_count <= 6)
    
    # Light cleanup of junction points
    if junction_mask.sum() > 0:
        clean_kernel = np.ones((2, 2), np.uint8)
        junction_mask_cleaned = cv2.morphologyEx(
            junction_mask.astype(np.uint8), 
            cv2.MORPH_OPEN, 
            clean_kernel
        ) > 0
        if junction_mask_cleaned.sum() > junction_mask.sum() * 0.3:
            junction_mask = junction_mask_cleaned
    
    junction_coords = np.where(junction_mask)
    junctions = list(zip(junction_coords[0], junction_coords[1])) if len(junction_coords[0]) > 0 else []
    
    # Corner points (pixels with 2 neighbors that form an angle)
    corner_mask = find_corner_points(skeleton_binary, neighbor_count)
    corner_coords = np.where(corner_mask)
    corners = list(zip(corner_coords[0], corner_coords[1])) if len(corner_coords[0]) > 0 else []
    
    # Deduplicate if requested
    if deduplicate:
        endpoints = deduplicate_points(endpoints, min_point_distance) if endpoints else []
        junctions = deduplicate_points(junctions, min_point_distance) if junctions else []
        corners = deduplicate_points(corners, min_point_distance) if corners else []
    
    return {
        'endpoint': endpoints,
        'junction': junctions,
        'corner': corners
    }


def select_spaced_points(
    points: List[Tuple[int, int]], 
    num_desired: int, 
    min_distance: int
) -> List[Tuple[int, int]]:
    """Select points ensuring they are at least min_distance apart.
    
    Uses greedy selection: pick random point, exclude nearby points, repeat.
    
    Args:
        points: List of (y, x) tuples to select from
        num_desired: Number of points to select
        min_distance: Minimum distance between selected points
        
    Returns:
        List of selected (y, x) tuples
    """
    import random
    
    if len(points) == 0:
        return []
    
    if min_distance <= 0 or len(points) <= num_desired:
        # No spacing constraint or not enough points - just random sample
        return random.sample(points, min(num_desired, len(points)))
    
    selected = []
    remaining = list(points)  # Make a copy
    
    while len(selected) < num_desired and len(remaining) > 0:
        # Pick a random point from remaining
        chosen = random.choice(remaining)
        selected.append(chosen)
        
        # Remove chosen point and all points within min_distance
        cy, cx = chosen
        remaining = [
            (y, x) for (y, x) in remaining
            if np.sqrt((y - cy)**2 + (x - cx)**2) > min_distance
        ]
    
    return selected


def create_asymmetric_gap_at_junction(
    image: np.ndarray, 
    skeleton: np.ndarray, 
    center_y: int, 
    center_x: int,
    gap_length_min: int = 1,
    gap_length_max: int = 24,
    gap_width: int = 2
) -> np.ndarray:
    """Create an asymmetric gap by erasing a segment away from the junction.
    
    Uses Endpoint Retraction approach with distance transform for complete erasure:
    1. Pick one branch emanating from the junction
    2. Walk away from junction along the skeleton
    3. Select a segment starting from safety_margin pixels away
    4. Use distance transform to find ALL pixels near the skeleton segment
    5. Erase all pixels within gap_width radius of the segment
    
    This ensures:
    - Junction center is never touched (safety margin)
    - No stubs remain (distance transform finds all nearby pixels)
    - Complete erasure even for thick lines
    
    Args:
        image: The image to modify (will be copied)
        skeleton: Binary skeleton of the image for branch detection
        center_y, center_x: Junction center coordinates
        gap_length_min: Minimum length of gap (in pixels along skeleton)
        gap_length_max: Maximum length of gap (in pixels along skeleton)
        gap_width: Width/radius of the eraser (in pixels)
        
    Returns:
        Modified image with asymmetric gap
    """
    import random
    
    result = image.copy()
    h, w = image.shape
    
    # Find neighboring skeleton pixels (branches coming into this junction)
    neighbors = []
    for dy in [-1, 0, 1]:
        for dx in [-1, 0, 1]:
            if dy == 0 and dx == 0:
                continue
            ny, nx = center_y + dy, center_x + dx
            if 0 <= ny < h and 0 <= nx < w and skeleton[ny, nx] > 0:
                neighbors.append((ny, nx, dy, dx))
    
    # Need at least one branch to create a gap
    if len(neighbors) == 0:
        return result
    
    # Randomly select which branch to create gap on
    branch_start = random.choice(neighbors)
    ny, nx, dy, dx = branch_start
    
    # Determine gap length
    gap_length = random.randint(gap_length_min, gap_length_max)
    
    # Safety margin: distance from junction before we start erasing
    # This ensures we never touch the junction center
    safety_margin = max(gap_width + 2, 5)
    
    # PHASE 1: Walk away from junction to find starting point for gap
    # Walk further than gap_length + safety_margin to get away from junction
    walk_distance = gap_length + safety_margin + 5
    
    path_away = []  # Store the path as we walk away
    current_y, current_x = ny, nx
    prev_y, prev_x = center_y, center_x
    
    for step in range(walk_distance):
        path_away.append((current_y, current_x))
        
        # Find next pixel along skeleton
        found_next = False
        best_dot = -2
        best_pos = None
        best_dir = (dy, dx)
        
        for search_dy in [-1, 0, 1]:
            for search_dx in [-1, 0, 1]:
                if search_dy == 0 and search_dx == 0:
                    continue
                next_y = current_y + search_dy
                next_x = current_x + search_dx
                
                # Don't go back to previous pixel
                if next_y == prev_y and next_x == prev_x:
                    continue
                
                # Check if valid skeleton pixel
                if (0 <= next_y < h and 0 <= next_x < w and 
                    skeleton[next_y, next_x] > 0):
                    # Prefer continuing in same direction (dot product)
                    dot_product = dy * search_dy + dx * search_dx
                    if dot_product > best_dot:
                        best_dot = dot_product
                        best_pos = (next_y, next_x)
                        best_dir = (search_dy, search_dx)
                        found_next = True
        
        if not found_next:
            # Reached end of line or dead end
            break
        
        prev_y, prev_x = current_y, current_x
        current_y, current_x = best_pos
        dy, dx = best_dir
        
    # If we didn't walk far enough, can't create a safe gap
    if len(path_away) < safety_margin + gap_length:
        return result
    
    # PHASE 2: Select the segment to erase
    # Start erasing from safety_margin distance away, for gap_length pixels
    skeleton_pixels_to_erase = []
    start_idx = safety_margin
    end_idx = min(start_idx + gap_length, len(path_away))
    
    for idx in range(start_idx, end_idx):
        skeleton_pixels_to_erase.append(path_away[idx])
    
    if len(skeleton_pixels_to_erase) == 0:
        return result
    
    # PHASE 3: Create a mask of skeleton pixels to erase
    erase_skeleton_mask = np.zeros((h, w), dtype=np.uint8)
    for py, px in skeleton_pixels_to_erase:
        erase_skeleton_mask[py, px] = 255
    
    # PHASE 4: Use distance transform to find ALL pixels near the skeleton path
    # This ensures we erase the entire thick line, not just around skeleton points
    dist_from_erase_path = cv2.distanceTransform(
        255 - erase_skeleton_mask,  # Invert: skeleton=0, background=255
        cv2.DIST_L2, 
        5
    )
    
    # Erase all pixels within gap_width distance of the skeleton path
    # Add extra margin to ensure complete erasure
    erase_radius = gap_width + 2
    erase_mask = dist_from_erase_path <= erase_radius
    
    # Apply the erasure
    result[erase_mask] = 0

    return result


def add_junction_gaps(
    skeleton_image: np.ndarray,
    junction_gap_min: float = 0.1,
    junction_gap_max: float = 0.5,
    junction_gap_cap: int = 10,
    corner_gap_min: float = 0.1,
    corner_gap_max: float = 0.3,
    corner_gap_cap: int = 10,
    random_gap_min: int = 0,
    random_gap_max: int = 5,
    deduplicate: bool = True,
    min_point_distance: int = 3,
    gap_length_min: int = 1,
    gap_length_max: int = 24,
    gap_width: int = 2,
    min_gap_distance: int = 0,
    min_endpoint_distance: int = 0,
) -> Tuple[np.ndarray, Dict[str, List[Tuple[int, int]]], Optional[np.ndarray]]:
    """Find junction points in a skeleton and add gaps at junctions, corners, and random points.
    
    Creates asymmetric gaps where one line is too short to meet the other,
    rather than both lines being equally shortened at junctions.
    
    Args:
        skeleton_image: Skeletonized line image (float32, [0,1])
        junction_gap_min: Minimum probability of gaps at junction points (0.0-1.0)
        junction_gap_max: Maximum probability of gaps at junction points (0.0-1.0)
        junction_gap_cap: Hard cap on number of junction gaps
        corner_gap_min: Minimum probability of gaps at corner points (0.0-1.0)
        corner_gap_max: Maximum probability of gaps at corner points (0.0-1.0)
        corner_gap_cap: Hard cap on number of corner gaps
        random_gap_min: Minimum number of gaps at random points (absolute)
        random_gap_max: Maximum number of gaps at random points (absolute)
        deduplicate: Whether to deduplicate nearby points (recommended: True)
        min_point_distance: Minimum distance between deduplicated points
        gap_length_min: Minimum length of gap erosion (in pixels along skeleton)
        gap_length_max: Maximum length of gap erosion (in pixels along skeleton)
        gap_width: Width/radius of the eraser (in pixels)
        min_gap_distance: Minimum distance between selected gap points (0 = no constraint)
        min_endpoint_distance: Minimum distance from endpoints for gap placement (0 = no constraint)
    
    Returns:
        tuple: (modified_image, junction_points_dict, endpoint_distance_map)
            - modified_image: Skeleton with gaps added
            - junction_points_dict: Dictionary with keys 'junction', 'corner', 'endpoint', 'random',
              each containing a list of (y, x) tuples
            - endpoint_distance_map: Distance transform from endpoints (can be reused for masking),
              or None if min_endpoint_distance <= 0
    """
    import random
    
    result = skeleton_image.copy()
    
    # Convert skeleton to uint8 for processing
    skeleton = (skeleton_image > 0.01).astype(np.uint8) * 255
    
    # Detect all keypoints using the unified helper function
    keypoints = detect_skeleton_keypoints(skeleton, deduplicate=deduplicate, min_point_distance=min_point_distance)
    junction_list = keypoints['junction']
    corner_list = keypoints['corner']
    endpoint_list = keypoints['endpoint']
    
    # Also need skeleton_binary for other operations in this function
    skeleton_binary = (skeleton > 0).astype(np.uint8)
    
    # Precompute distance transform from endpoints for fast filtering
    # This turns O(n*m) distance calculations into O(1) lookups
    endpoint_distance_map = None
    if min_endpoint_distance > 0 and len(endpoint_list) > 0:
        h, w = skeleton.shape
        endpoint_mask = np.ones((h, w), dtype=np.uint8)  # 1 = background
        for ey, ex in endpoint_list:
            endpoint_mask[ey, ex] = 0  # 0 = endpoint
        endpoint_distance_map = cv2.distanceTransform(endpoint_mask, cv2.DIST_L2, 3)
    
    # Helper function to filter out points too close to endpoints (now O(n) with lookups)
    def filter_points_near_endpoints(points: List[Tuple[int, int]], point_type: str = "") -> List[Tuple[int, int]]:
        """Filter out points that are too close to any endpoint."""
        if endpoint_distance_map is None or len(points) == 0:
            return points
        
        # Vectorized lookup: extract distances for all points at once
        if len(points) > 100:
            # For large point lists, use numpy indexing
            points_arr = np.array(points)
            distances = endpoint_distance_map[points_arr[:, 0], points_arr[:, 1]]
            mask = distances > min_endpoint_distance
            filtered = [points[i] for i in range(len(points)) if mask[i]]
        else:
            # For small lists, simple loop is fine
            filtered = [(y, x) for y, x in points if endpoint_distance_map[y, x] > min_endpoint_distance]
        
        return filtered
    
    # Filter junctions and corners to exclude those near endpoints
    if min_endpoint_distance > 0:
        junction_list = filter_points_near_endpoints(junction_list, "junction")
        corner_list = filter_points_near_endpoints(corner_list, "corner")
    
    # Get all skeleton points for random gap selection (exclude junctions, corners, endpoints)
    all_skeleton_coords = np.where(skeleton_binary > 0)
    all_skeleton_list = list(zip(all_skeleton_coords[0], all_skeleton_coords[1]))
    
    # Create set of special points (junctions, corners, endpoints) to exclude from random selection
    special_points = set(junction_list + corner_list + endpoint_list)
    
    # Filter out special points from random candidates
    random_candidates = [pt for pt in all_skeleton_list if pt not in special_points]
    
    # Filter out random candidates too close to endpoints
    if min_endpoint_distance > 0:
        random_candidates = filter_points_near_endpoints(random_candidates, "random")
    
    # Deduplicate random candidates
    if deduplicate and len(random_candidates) > 0:
        random_candidates = deduplicate_points(random_candidates, min_point_distance)
    
    # Add gaps for each type separately
    # Collect all selected gap points across all types
    all_selected_gaps = []
    selected_junctions = []
    selected_corners = []
    selected_randoms = []
    
    # 1. Junction gaps (3+ branches meeting) - probabilistic range with cap
    if len(junction_list) > 0 and junction_gap_max > 0:
        # Apply hard cap to limit maximum number of gaps
        max_available = min(junction_gap_cap, len(junction_list))
        # Randomly sample from junction_list if we have more junctions than the cap
        if len(junction_list) > junction_gap_cap:
            junction_list = random.sample(junction_list, junction_gap_cap)
        
        # Select probability within min/max range and calculate number of gaps
        gap_probability = random.uniform(junction_gap_min, junction_gap_max)
        num_junction_gaps = max(1, int(gap_probability * len(junction_list)))
        num_junction_gaps = min(num_junction_gaps, max_available)
        
        selected_junctions = select_spaced_points(
            junction_list, num_junction_gaps, min_gap_distance
        )
        all_selected_gaps.extend(selected_junctions)
        
        for center_y, center_x in selected_junctions:
            result = create_asymmetric_gap_at_junction(
                result, skeleton_binary, center_y, center_x,
                gap_length_min, gap_length_max, gap_width
            )
    
    # 2. Corner gaps (2 branches at angles) - probabilistic range with cap
    # Exclude corners too close to already selected junctions
    if len(corner_list) > 0 and corner_gap_max > 0:
        # Filter out corners too close to existing gaps
        available_corners = corner_list
        if min_gap_distance > 0 and len(all_selected_gaps) > 0:
            available_corners = [
                (y, x) for (y, x) in corner_list
                if all(np.sqrt((y - gy)**2 + (x - gx)**2) > min_gap_distance 
                       for gy, gx in all_selected_gaps)
            ]
        
        if len(available_corners) > 0:
            # Apply hard cap to limit maximum number of gaps
            max_available = min(corner_gap_cap, len(available_corners))
            # Randomly sample from available_corners if we have more corners than the cap
            if len(available_corners) > corner_gap_cap:
                available_corners = random.sample(available_corners, corner_gap_cap)
            
            # Select probability within min/max range and calculate number of gaps
            gap_probability = random.uniform(corner_gap_min, corner_gap_max)
            num_corner_gaps = max(1, int(gap_probability * len(available_corners)))
            num_corner_gaps = min(num_corner_gaps, max_available)
            
            selected_corners = select_spaced_points(
                available_corners, num_corner_gaps, min_gap_distance
            )
            all_selected_gaps.extend(selected_corners)
            
            for center_y, center_x in selected_corners:
                result = create_asymmetric_gap_at_junction(
                    result, skeleton_binary, center_y, center_x,
                    gap_length_min, gap_length_max, gap_width
                )
    
    # 3. Random gaps (arbitrary points along the line) - absolute min/max
    # Exclude points too close to already selected gaps
    if len(random_candidates) > 0 and random_gap_max > 0:
        # Filter out random points too close to existing gaps
        available_randoms = random_candidates
        if min_gap_distance > 0 and len(all_selected_gaps) > 0:
            available_randoms = [
                (y, x) for (y, x) in random_candidates
                if all(np.sqrt((y - gy)**2 + (x - gx)**2) > min_gap_distance 
                       for gy, gx in all_selected_gaps)
            ]
        
        if len(available_randoms) > 0:
            # Select absolute number within min/max range
            num_random_gaps = random.randint(random_gap_min, min(random_gap_max, len(available_randoms)))
            
            if num_random_gaps > 0:
                selected_randoms = select_spaced_points(
                    available_randoms, num_random_gaps, min_gap_distance
                )
                all_selected_gaps.extend(selected_randoms)
                
                for center_y, center_x in selected_randoms:
                    result = create_asymmetric_gap_at_junction(
                        result, skeleton_binary, center_y, center_x,
                        gap_length_min, gap_length_max, gap_width
                    )
    
    # Return dictionary with deduplicated lists
    junction_points_dict = {
        'junction': junction_list,
        'corner': corner_list,
        'endpoint': endpoint_list,
        'random': selected_randoms  # Return the selected random gap points
    }
    
    return result, junction_points_dict, endpoint_distance_map


def pad_to_size(image: np.ndarray, target_size: int) -> Optional[np.ndarray]:
    """
    Pad image to target_size x target_size.
    
    Only pads along dimensions where no line pixels touch the border.
    If line pixels touch a border, that dimension will not be padded (to preserve border content).

    If there are <2 sides that can be padded, return None
    
    Args:
        image: Binary line image (H, W)
        target_size: Target size for both dimensions
        
    Returns:
        Padded binary image (up to target_size x target_size)
    """
    h, w = image.shape
    
    # First, crop any dimensions that are too large (center crop)
    if h > target_size:
        y_start = (h - target_size) // 2
        image = image[y_start:y_start+target_size, :]
        h = target_size
    
    if w > target_size:
        x_start = (w - target_size) // 2
        image = image[:, x_start:x_start+target_size]
        w = target_size
    
    # If already the right size, return as is
    if h == target_size and w == target_size:
        return image
    
    # Check if line pixels touch borders (line pixels > threshold)
    line_threshold = 0.01
    touches_top = np.any(image[0, :] > line_threshold)
    touches_bottom = np.any(image[-1, :] > line_threshold)
    touches_left = np.any(image[:, 0] > line_threshold)
    touches_right = np.any(image[:, -1] > line_threshold)
    
    # If there are <2 sides that can be padded, return None
    if not (touches_top or touches_bottom) and not (touches_left or touches_right):
        return None
    
    # Only pad dimensions where lines don't touch borders
    pad_height = h < target_size and not (touches_top or touches_bottom)
    pad_width = w < target_size and not (touches_left or touches_right)
    
    # Determine final dimensions
    final_h = target_size if pad_height else h
    final_w = target_size if pad_width else w
    
    # If we can't reach target_size in both dimensions, return None
    if final_h != target_size or final_w != target_size:
        return None
    
    # If no padding needed, return as is
    if final_h == h and final_w == w:
        return image
    
    # Create padded image (background is 0 = white in binary line drawing)
    padded = np.zeros((final_h, final_w), dtype=np.float32)
    
    # Calculate offsets (center the image in padded dimensions)
    y_offset = (final_h - h) // 2 if pad_height else 0
    x_offset = (final_w - w) // 2 if pad_width else 0
    
    padded[y_offset:y_offset+h, x_offset:x_offset+w] = image

    if padded.shape[0] != target_size or padded.shape[1] != target_size:
        return None
    
    return padded


def crop_around_lines_binary(binary_image: np.ndarray, crop_size: int) -> Optional[np.ndarray]:
    """Create a bounding box around line pixels and take a random crop.
    
    Uses segmentation_cpu.cropping utilities to find content bbox.
    
    Args:
        binary_image: Binary line image (H, W) as float32 [0, 1]
        crop_size: Target crop size
        
    Returns:
        Cropped binary image (crop_size, crop_size) or None if image is empty
    """
    h, w = binary_image.shape
    
    # Check if image has any content
    if np.sum(binary_image) == 0:
        return None
    
    # Convert to uint8 for bbox detection
    binary_uint8 = (binary_image * 255).astype(np.uint8)
    
    # Get bounding box with padding
    try:
        vert_pad_dims, horiz_pad_dims = get_bbox_pad_dims(binary_uint8, padding=0)
        bbox_pad_dims = (vert_pad_dims, horiz_pad_dims)
    except Exception:
        # If bbox detection fails, return None
        return None
    
    # Crop to bbox
    cropped_uint8, _, _ = crop_image(binary_uint8, padding=0, bbox_pad_dims=bbox_pad_dims)
    
    # Convert back to float
    cropped = cropped_uint8.astype(np.float32) / 255.0
    
    bbox_h, bbox_w = cropped.shape
    
    # If bounding box is smaller than crop_size, pad it
    if bbox_h <= crop_size and bbox_w <= crop_size:
        return pad_to_size(cropped, crop_size)
    
    # Take random crop within the bounding box
    if bbox_h >= crop_size:
        y_start = random.randint(0, bbox_h - crop_size)
    else:
        y_start = 0
    
    if bbox_w >= crop_size:
        x_start = random.randint(0, bbox_w - crop_size)
    else:
        x_start = 0
    
    # Extract crop
    y_end = min(y_start + crop_size, bbox_h)
    x_end = min(x_start + crop_size, bbox_w)
    cropped_region = cropped[y_start:y_end, x_start:x_end]
    
    # If crop is smaller than target, pad it
    if cropped_region.shape[0] < crop_size or cropped_region.shape[1] < crop_size:
        cropped_region = pad_to_size(cropped_region, crop_size)

    return cropped_region


def crop_around_lines_binary_with_retry(
    binary_image: np.ndarray,
    crop_size: int,
    max_attempts: int = 5,
) -> Optional[np.ndarray]:
    """Crop binary image around line pixels with retry logic for empty crops.
    
    Wraps crop_around_lines_binary with retry logic to avoid empty crops.
    
    Args:
        binary_image: Binary image (H, W)
        crop_size: Target crop size
        max_attempts: Maximum number of retry attempts (default 5)
        
    Returns:
        Cropped binary image (crop_size, crop_size)
    """
    for attempt in range(max_attempts):
        cropped_binary = crop_around_lines_binary(binary_image, crop_size)

        # If empty and not last attempt, try again with different random seed
        if cropped_binary is None and attempt < max_attempts - 1:
            continue

        return cropped_binary

def compute_stroke_properties(path: List[Tuple[int, int]]) -> Dict[str, np.ndarray]:
    """Compute geometric properties along a stroke path.
    
    Args:
        path: List of (y, x) coordinates defining the stroke
        
    Returns:
        Dictionary with keys:
        - 'position': Position along stroke [0, 1] for each point
        - 'tangent': Unit tangent vector (dy, dx) for each point
        - 'normal': Unit normal vector perpendicular to tangent
        - 'curvature': Curvature (rate of direction change) at each point
    """
    if len(path) < 2:
        return {
            'position': np.array([0.0]),
            'tangent': np.array([[0.0, 1.0]]),
            'normal': np.array([[-1.0, 0.0]]),
            'curvature': np.array([0.0])
        }
    
    path_array = np.array(path, dtype=np.float32)
    n = len(path)
    
    # Position along stroke (0 to 1)
    position = np.linspace(0, 1, n)
    
    # Compute tangent vectors using central differences
    tangent = np.zeros((n, 2), dtype=np.float32)
    
    for i in range(n):
        if i == 0:
            # Forward difference at start
            tangent[i] = path_array[1] - path_array[0]
        elif i == n - 1:
            # Backward difference at end
            tangent[i] = path_array[-1] - path_array[-2]
        else:
            # Central difference in middle
            tangent[i] = path_array[i + 1] - path_array[i - 1]
    
    # Normalize tangent vectors
    tangent_mag = np.linalg.norm(tangent, axis=1, keepdims=True)
    tangent_mag = np.maximum(tangent_mag, 1e-6)  # Avoid division by zero
    tangent = tangent / tangent_mag
    
    # Compute normal vectors (rotate tangent by 90 degrees)
    # normal = [-dy, dx] rotates tangent [dy, dx] by 90 degrees clockwise
    normal = np.stack([-tangent[:, 1], tangent[:, 0]], axis=1)
    
    # Compute curvature (change in tangent direction)
    curvature = np.zeros(n, dtype=np.float32)
    for i in range(1, n - 1):
        # Curvature = ||d(tangent)/ds||
        dt = tangent[i + 1] - tangent[i - 1]
        curvature[i] = np.linalg.norm(dt)
    
    # Endpoints get curvature of nearest interior point
    if n > 2:
        curvature[0] = curvature[1]
        curvature[-1] = curvature[-2]
    
    return {
        'position': position,
        'tangent': tangent,
        'normal': normal,
        'curvature': curvature
    }

