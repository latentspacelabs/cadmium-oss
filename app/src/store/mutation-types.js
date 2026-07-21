/* eslint-disable linebreak-style */
// export const FOO = 'foo';
export const SET_IMAGE_DATA_FOR_FRAME_WITH_ID = 'set_image_data_for_frame_with_id';
export const CREATE_EMPTY_FRAME_IF_NONE_EXISTS = 'create_empty_frame_if_none_exists';
export const SET_SELECTED_FRAME_NUMBER = 'set_selected_frame_number';
export const SET_SELECTED_FRAME_TO_PREVIOUS_FRAME = 'set_selected_frame_to_previous_frame';
export const SET_SELECTED_FRAME_TO_NEXT_FRAME = 'set_selected_frame_to_next_frame';
export const SET_SELECTED_FRAME_TO_NEXT_UNIQUE_FRAME = 'set_selected_frame_to_next_unique_frame';
export const SET_SELECTED_FRAME_TO_PREVIOUS_UNIQUE_FRAME = 'set_selected_frame_to_previous_unique_frame';
export const SET_FRAME_SELECTED = 'set_frame_selected';
export const SET_FRAME_ORIGINAL = 'set_frame_original';
export const SET_FRAMES_SELECTED = 'set_frames_selected';
export const SET_FRAMES_SELECTED_ON_WHOLE_LAYER = 'set_frames_selected_on_whole_layer';
export const SET_FRAMES_TO_LOADING = 'set_frames_to_loading';
export const SET_TMP_IMAGE_ROOT_PATH = 'set_tmp_image_root_path'; // root directory for loading images, temporary, TODO: Delete
export const DESELECT_FRAMES = 'deselect_frames';
export const DESELECT_ALL_FRAMES_ON_LAYER = 'deselect_all_frames_on_layer';
export const CREATE_PLAYER_INTERVAL = 'create_player_interval';
export const DESTROY_PLAYER_INTERVAL = 'destroy_player_interval';
export const SET_PLAYER_FPS = 'set_player_fps';
export const CREATE_PLAYER_RAF = 'create_player_raf';
export const DESTROY_PLAYER_RAF = 'destroy_player_raf';
export const SET_REF_FRAMES_FOR_FRAME = 'set_ref_frames_for_frame';
export const SET_PLAYER_LOOP_ENABLED = 'set_player_loop_enabled';
export const SET_PLAYER_LOOP_IN = 'set_player_loop_in';
export const SET_PLAYER_LOOP_OUT = 'set_player_loop_out';
export const TOGGLE_LAYER_VISIBILITY = 'toggle_layer_visibility';
export const TOGGLE_TIMELINE_VISIBILITY = 'toggle_timeline_visibility';
export const DELETE_SELECTED_FRAMES = 'delete_selected_frames';
export const DETACH_SELECTED_FRAMES_FROM_THEIR_IMAGE_DATA = 'detach_selected_frames_from_their_image_data';
export const SET_FILE_DRAG_N_DROP_IN_PROGRESS = 'set_file_drag_n_drop_in_progress';
export const SET_LAST_IMPORTED_IMAGE_TOO_BIG = 'set_last_imported_image_too_big';
export const SET_LAST_IMPORTED_IMAGE_HAS_DIFFERENT_DIMS_THAN_CANVAS = 'set_last_imported_image_has_different_dims_than_canvas';
export const SET_TIMELINE_SCROLL_VALUE_X = 'set_timeline_scroll_value_x';
export const SET_ACTIVE_LAYER_ID = 'set_active_layer_id';
// export const SET_SEGMENTATION_MAP_FOR_FRAME = 'set_segmentation_map_for_frame';
// replaced by SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID
export const SET_SEGMENTATION_MAP_GENERATION_PROGRESS = 'set_segmentation_map_generation_progress';
export const SET_COLORIZATION_PROGRESS = 'set_colorization_progress';
export const SET_UPDATED_COLORS_PROGRESS = 'set_updated_colors_progress';
export const SET_ANALYZE_MODE_ONLY = 'set_analyze_mode_only';
export const SET_AI_GAP_CLOSER_ENABLED = 'set_ai_gap_closer_enabled';
export const SET_MAX_AI_DILATION_SIZE = 'set_max_ai_dilation_size';
export const SET_MAX_TB_DILATION_SIZE = 'set_max_tb_dilation_size';
export const SET_MIN_SEG_SIZE = 'seg_min_seg_size';
export const SET_LINE_THRESHOLD = 'set_line_threshold';
export const SET_MAX_ITER = 'set_max_iter';
export const SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION = 'set_time_for_last_segmentation_map_generation';
export const SET_LAST_EXPORT_TIME = 'set_last_export_time';
export const SET_TIME_FOR_LAST_COLORIZATION = 'set_time_for_last_colorization';
export const SET_FILE_IMPORT_CANCELED_BY_USER = 'set_file_import_canceled_by_user';
export const SET_LAYER_TYPE_OF_FILES_TO_IMPORT = 'set_layer_type_of_files_to_import';
export const SET_COLORIZATION_IN_PROGRESS = 'set_colorization_in_progress';
export const SET_UPDATE_COLORS_IN_PROGRESS = 'set_update_colors_in_progress';
export const SET_COLORIZATION_CANCELED_BY_USER = 'set_colorization_canceled_by_user';
export const SET_UPDATE_COLORS_CANCELED_BY_USER = 'set_update_colors_canceled_by_user';
export const SET_EXPORT_IN_PROGRESS = 'set_export_in_progress';
export const SET_EXPORT_PROGRESS = 'set_export_progress';
export const SET_EXPORT_CANCELED_BY_USER = 'set_export_canceled_by_user';
export const SET_EXPORTING_COLORS_SEPARATELY = 'set_exporting_colors_separately';
export const SET_CURRENT_PROCESSING_TASK = 'set_current_processing_task';
export const ENABLE_FAKE_COLORIZATION = 'enable_fake_colorization';
export const SET_CANVAS_SIZE = 'set_canvas_size';
export const SET_AVAILABLE_SPACE_FOR_CANVAS = 'set_available_space_for_canvas';
export const SET_CANVAS_SCALE = 'set_canvas_scale';
export const SET_CANVAS_TOOL_ACTIVE = 'set_canvas_tool_active';
export const SET_BACKGROUND_COLOR = 'set_background_color';

// MODULE ToolControls
export const TOGGLE_TOOL_CONTROL_WITH_ID = 'toggle_tool_control_with_id';
export const SHOW_TOOL_CONTROL_WITH_ID = 'show_tool_control_with_id';
export const HIDE_TOOL_CONTROL_WITH_ID = 'hide_tool_control_with_id';
export const HIDE_ALL_TOOL_CONTROLS = 'hide_all_tool_controls';
export const SET_SELECTED_COLOR = 'set_selected_color';
export const SET_RESERVED_COLOR = 'set_reserved_color';
export const SET_PREVIOUS_CANVAS_TOOL_ID = 'set_previous_canvas_tool_id';
export const SET_ACTIVE_CANVAS_TOOL_ID = 'set_active_canvas_tool_id';

// MODULE FillTool
export const SET_FILL_TOOL_MODE = 'set_fill_tool_mode';
export const SET_FILL_TOOL_EXPAND = 'set_fill_tool_expand';
export const SET_FILL_TOOL_RANGE = 'set_fill_tool_range';
export const SET_FILL_COLLAPSE = 'set_fill_collapse';

// MODULE ZoomTool
export const SET_ZOOM_TOOL_MODE = 'set_zoom_tool_mode';

// MODULE ImageStore
export const REMOVE_IMAGE_FROM_IMAGE_STORE_BY_ID = 'remove_image_from_image_store_by_id';
export const ADD_NEW_IMAGE_TO_IMAGE_STORE = 'add_new_image_to_image_store';
export const INCREMENT_IMAGE_DATA_USAGE = 'increment_image_data_usage';
export const SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID = 'set_segmentation_map_path_for_image_with_id';
// this can be found in imagestore
export const REPLACE_IMAGE_DATA_URI = 'replace_image_data_uri';
// like REPLACE_IMAGE_DATA_URI but ONLY sets dataUri+hash — it does NOT null
// segmentationMapPath. Used by the AssetStore facade to rehydrate bytes from
// the disk tier without destroying a still-valid segmap path (see asset-store.js).
export const HYDRATE_IMAGE_DATA_URI = 'hydrate_image_data_uri';
export const INCREMENT_IMAGE_DATA_USAGE_BY_IMAGE_DATA_ID = 'increment_image_data_usage_by_image_data_id';
export const SET_CANVAS_REDRAW_TRIGGER = 'set_canvas_redraw_trigger';

// MODULE Palette
export const ADD_COLOR_TO_PALETTE = 'add_color_to_palette';
export const CLEAR_COLOR_PALETTE = 'clear_color_palette';
export const DELETE_COLOR_FROM_PALETTE = 'delete_color_from_palette';
export const SET_PALETTE_EVENT_OCCURRED = 'set_palette_event_occurred';
export const TOGGLE_SWATCH_VISIBILITY = 'toggle_swatch_visibility';
export const SET_COLOR_COLLAPSE = 'set_color_collapse';

// MODULE PenTool
export const SET_PEN_TOOL_DIAMETER = 'set_pen_tool_diameter';
export const SET_PEN_TOOL_MODE = 'set_pen_tool_mode';
export const SET_PEN_DRAW_MODE = 'set_pen_draw_mode';
export const SET_PEN_DRAW_MODE_PREVIOUS = 'set_pen_draw_mode_previous';
export const SET_PEN_COLLAPSE = 'set_pen_collapse';

// MODULE eraserTool
export const SET_ERASER_TOOL_DIAMETER = 'set_eraser_tool_diameter';
export const SET_ERASER_COLLAPSE = 'set_eraser_collapse';

// MODULE Pressure
export const SET_PRESSURE_ENABLED = 'set_pressure_enabled';

// MODULE Reference Panel
export const SET_REFERENCE_COLLAPSE = 'set_reference_collapse';

// MODULE ANALYZE Options
export const SET_RAINBOW_MODE = 'set_rainbow_mode';

// Auto Updater
export const SET_UPDATE_IN_PROGRESS = 'set_update_in_progress';
export const SET_UPDATE_PERCENTAGE = 'set_update_percentage';

export const SET_TEMP_FILE_PATHS = 'set_temp_file_paths';
export const SET_CURRENT_FILE = 'set_current_file';
export const SET_UNSAVED_CHANGES = 'set_unsaved_changes';
export const SET_NEW_PROJECT = 'set_new_project';
export const SET_ANALYZE_CANCELED_BY_USER = 'set_analyze_canceled_by_user';
export const ADD_FILE_TO_REFERENCE_FILES = 'add_file_to_reference_files';
export const DELETE_FILE_FROM_REFERENCE_FILES = 'delete_file_from_reference_files';
export const SET_SELECTED_REFERENCE_FILE = 'set_selected_reference_file';
export const SET_REF_CANVAS_SIZE = 'set_ref_canvas_size';
export const SET_REF_WIN_HEIGHT = 'set_ref_win_height';
export const SET_REF_WIN_WIDTH = ' set_ref_win_width';
export const SET_REF_CAN_POS = 'set_ref_can_pos';
export const SET_REF_CAN_SCALE = 'set_ref_can_scale';
export const SET_SEG_OPTIONS_COLLAPSE = 'set_seg_options_collapse';
export const SET_SEG_PANEL_HIGHLIGHT = 'set_seg_panel_highlight';
export const SET_PROJECT_ID = 'set_project_id';
export const TOGGLE_AUTO_ALPHA = 'toggle_auto_alpha';

// Applies an undo/redo inverse patch (see services/state-patch.js). Committed
// only by the undo-redo plugin; walks path->value ops with Vue.set/Vue.delete
// so reactivity holds without replaceState.
export const APPLY_STATE_PATCH = 'apply_state_patch';
export const SET_SERVER_BACKEND = 'set_server_backend';
