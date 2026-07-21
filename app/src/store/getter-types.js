/* eslint-disable linebreak-style */
/* eslint-disable import/prefer-default-export */

export const FRAME_COUNT = 'frame_count';
export const SELECTED_FRAME_NR = 'selected_frame_nr'; // playhead, TODO: Change name
// export const SELECTED_FRAMES = 'selected_frames';
export const SELECTED_FRAMES_ON_LAYER = 'selected_frames_on_layer';
export const FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID = 'frame_ids_with_same_image_data_id';
// export const FRAME_ID_OF_FIRST_FRAME_IN_BLOCK = 'frame_id_of_first_frame_in_block';
export const FRAMES_HAVE_SAME_IMAGE_DATA_ID = 'frames_have_same_image_data_id';

export const LAYER_HAS_FRAMES = 'layer_has_frames';
export const TIMELINE_HAS_FRAMES = 'timeline_has_frames';
export const TIMELINE_HAS_FRAMES_WITH_IMAGE_DATA = 'timeline_has_frames_with_image_data_id';
export const TIMELINE_VISIBILITY = 'timeline_visibility';
export const LAYER_TYPE = 'layer_type';
export const LINKED_LAYER_ID = 'linked_layer_id';

export const FRAMES_BY_LAYER_ID = 'frames_by_layer_id';
export const FRAME_IS_SELECTED = 'frame_is_selected';
export const FRAME_IS_ORIGINAL = 'frame_is_original';
export const FRAME_IS_PLACEHOLDER = 'frame_is_placeholder';

export const LAYER_BY_ID = 'layer_by_id';

export const LINE_HASH_FOR_SELECTED_FRAME = 'line_has_for_selected_frame';
export const LINE_IMAGE_FOR_SELECTED_FRAME = 'line_image_for_selected_frame';
export const COLOR_IMAGE_FOR_SELECTED_FRAME = 'color_image_for_selected_frame';
export const COLOR_IMAGE_ID_FOR_SELECTED_FRAME = 'color_image_id_for_selected_frame';
export const LINE_IMAGE_ID_FOR_SELECTED_FRAME = 'line_image_id_for_selected_frame';
export const IMAGE_DATA_OF_FRAME = 'image_data_of_frame';
export const IMAGE_DATA_OBJECT_OF_FRAME = 'image_data_object_of_frame';
export const FRAME_BY_FRAME_NR = 'frame_by_frame_nr';
export const SELECTED_FRAME_NRS_ON_ALL_LAYERS = 'selected_frame_nrs_on_all_layers';
export const IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS = 'image_data_ids_of_selected_frames_on_all_layers';

// Player
export const PLAYER_IS_PLAYING = 'player_is_playing';
export const PLAYER_FPS = 'player_fps';

export const LEFT_MOST_LINKED_LINE_FRAME_NR = 'left_most_linked_line_frame_nr';
export const SURROUNDING_REFERENCE_FRAME_NRS_FOR_LINE_FRAME = 'surrounding_reference_frame_nrs_for_line_frame';
export const FRAME_NRS_IN_LAYER = 'frame_nrs_in_layer';
export const REFERENCE_FRAME_NRS_FOR_LAYER_WITH_ID = 'reference_frames_nrs_for_layer_with_id';

export const REFERENCE_FRAMES_IN_USE_FOR_SELECTION = 'reference_frames_in_use_for_selection';

export const LAYER_IS_VISIBLE = 'layer_is_visible';
export const LAYER_IS_DRAWABLE = 'layer_is_drawable';

// other
export const FILE_DRAG_N_DROP_IN_PROGRESS = 'file_drag_n_drop_in_progress';
export const LAST_IMAGE_IS_TOO_BIG = 'last_image_is_too_big';
export const LAST_IMAGE_DIFFERENT_TO_CANVAS_SIZE = 'last_image_different_to_canvas_size';
export const NUMBER_OF_IMAGES_TO_LOAD = 'number_of_images_to_load';
export const NUMBER_OF_IMAGES_LOADED_IN_LAST_IMPORT = 'number_of_images_loaded_in_last_import';
export const LAYER_ID_OF_LAST_CLICKED_FRAME = 'layer_id_of_last_clicked_frame';
export const LAST_SEGMENTATION_MAP_GENERATION_TIME = 'last_segmentation_map_generation_time';
export const FILE_IMPORT_CANCELED_BY_USER = 'file_import_canceled_by_user';
export const LAYER_TYPE_OF_FILES_TO_IMPORT = 'layer_type_of_files_to_import';
export const COLORIZATION_IN_PROGRESS = 'colorization_in_progress';
export const UPDATE_COLORS_IN_PROGRESS = 'update_colors_in_progress';
export const EXPORT_IN_PROGRESS = 'export_in_progress';
export const SEG_PANEL_HIGHLIGHT = 'seg_panel_highlight';
// export const NUMBER_OF_IMAGES_EXPORTING = 'number_of_images_exporting';
export const ANALYZE_MODE_ONLY = 'analyze_mode_only';
export const AI_GAP_CLOSER_ENABLED = 'ai_gap_closer_enabled';
export const MAX_AI_DILATION_SIZE = 'max_ai_dilation_size';
export const MAX_TB_DILATION_SIZE = 'max_tb_dilation_size';
export const LINE_THRESHOLD = 'line_threshold';
export const MIN_SEG_SIZE = 'min_seg_size';
export const MAX_ITER = 'max_iter';
export const COLORIZATION_PROGRESS = 'colorization_progress';
export const UPDATED_COLORS_PROGRESS = 'updated_colors_progress';
export const COLORIZATION_CANCELED_BY_USER = 'colorization_canceled_by_user';
export const UPDATE_COLORS_CANCELED_BY_USER = 'update_colors_canceled_by_user';
export const EXPORT_PROGRESS = 'export_progress';
export const EXPORT_CANCELED_BY_USER = 'export_canceled_by_user';
export const EXPORTING_COLORS_SEPARATELY = 'exporting_colors_separately';
export const ESTIMATED_COLORIZATION_AND_SEGMENTATION_TIME_IN_SEC = 'estimated_colorization_and_segmentation_time_in_sec';
export const ESTIMATED_EXPORT_TIME_IN_SEC = 'estimated_export_time_in_sec';
export const CURRENT_PROCESSING_TASK = 'CURRENT_PROCESSING_TASK';
export const CANVAS_SIZE = 'canvas_size';
export const AVAILABLE_SPACE_FOR_CANVAS = 'available_space_for_canvas';
export const CANVAS_SCALE = 'canvas_scale';
export const CANVAS_TOOL_ACTIVE = 'canvas_tool_active';

// MODULE: ToolControls
export const TOOL_CONTROLS_VISIBLE = 'tool_controls_visible';
export const TOOL_CONTROL_ITEM_IS_VISIBLE = 'tool_control_item_is_visible';
// export const ACTIVE_TOOLS = 'active_tools';
export const PREVIOUS_CANVAS_TOOL_ID = 'previous_canvas_tool_id';
export const ACTIVE_CANVAS_TOOL = 'active_canvas_tool';
export const ACTIVE_CANVAS_TOOL_ID = 'active_canvas_tool_id';
export const TOOL_CONTROL_ITEM_BY_ID = 'tool_control_item_by_id';
// export const FILL_TOOL_ACTIVE = 'fill_tool_active';

// MODULE: timeline
export const TIMELINE_SCROLL_VALUE_X = 'timeline_scroll_value_x';

// ColorChooser
export const SELECTED_COLOR = 'selected_color';
export const RESERVED_COLOR = 'reserved_color';
export const BACKGROUND_COLOR = 'background_color';

// MODULE: FillTool
export const FILL_TOOL_MODE = 'fill_tool_mode';
export const FILL_TOOL_EXPAND = 'fill_tool_expand';
export const FILL_TOOL_RANGE = 'fill_tool_range';
export const IS_FILL_METHOD_SEGMAP = 'is_fill_method_segmap';
export const FILL_COLLAPSE = 'fill_collapse';

// MODULE: ZoomTool
export const ZOOM_TOOL_MODE = 'zoom_tool_mode';

// MODULE ImageStore
export const IMAGE_DATA_OBJECT_BY_HASH = 'image_data_object_by_hash';
export const IMAGE_DATA_URI_BY_IMAGE_DATA_ID = 'image_data_uri_by_image_data_id';
export const IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID = 'image_data_object_by_image_data_id';
export const SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID = 'segmentation_map_path_of_image_with_id';
export const IMAGE_HAS_SEGMENTATION_MAP = 'image_has_segmentation_map';
export const CANVAS_REDRAW_TRIGGER = 'canvas_redraw_trigger';

// MODULE palette
export const COLOR_PALETTE = 'color_palette';
export const PALETTE_EVENT_OCCURRED = 'palette_event_occurred';
export const COLOR_COLLAPSE = 'color_collapse';

// MODULE PenTool
export const PEN_TOOL_DIAMETER = 'pen_tool_diameter';
export const PEN_TOOL_MODE = 'pen_tool_mode';
export const PEN_DRAW_MODE = 'pen_draw_mode';
export const PEN_DRAW_MODE_PREVIOUS = 'pen_draw_mode_previous';
export const PEN_COLLAPSE = 'pen_collapse';
// MODULE eraserTool
export const ERASER_TOOL_DIAMETER = 'eraser_tool_diameter';
export const ERASER_COLLAPSE = 'eraser_collapse';
// MODULE Pressure
export const IS_PRESSURE_ENABLED = 'is_pressure_enabled';
export const ACTIVE_LAYER_ID = 'active_layer_id';
// Auto updater
export const UPDATE_IN_PROGRESS = 'update_in_progress';
export const UPDATE_PERCENTAGE = 'update_percentage';
// MODULE REFERENCE PANEL
export const REFERENCE_COLLAPSE = 'reference_collapse';

// MODULE ANALYZE OPTIONS
export const RAINBOW_MODE = 'rainbow_mode';

export const SAVE_STATE = 'save-state';
export const CURRENT_FILE = 'current-file';
export const UNSAVED_CHANGES = 'unsaved-changes';
export const COLOR_PREVIEW_MODE = 'color-preview-mode';
export const EST_TIME_REMAINING = 'est-time-remaining';
export const ANALYZE_CANCELED_BY_USER = 'analyze-canceled-by-user';
export const REFERENCE_IMAGES = 'reference_images';
export const REF_CANVAS_SIZE = 'ref_canvas_size';
export const REF_WIN_HEIGHT = 'ref_win_height';
export const REF_WIN_WIDTH = 'ref_win_width';
export const REF_CAN_POS = 'ref_can_pos';
export const REF_CAN_SCALE = 'ref_can_scale';

export const SEG_OPTIONS_COLLAPSE = 'seg_options_collapse';
export const IS_IMAGEDATAID_UNIQUE = 'is_imagedataid_unique';

export const PROJECT_ID = 'project_id';
export const IS_AUTO_ALPHA = 'is_auto_alpha';
export const SERVER_BACKEND = 'server_backend';
