/* eslint-disable linebreak-style */
/*
 * All actions are listed here. The benefit of using constants to access them
 * is compiler checking, so it does not happen at run-time that a misspelled or
 * non-existing action is being called.
 * So always use these constants and not the strings directly.
 */

/* eslint-disable import/prefer-default-export */
/* eslint-disable linebreak-style */

export const SAVE_FILE = 'save_file';
export const CREATE_SAVED_FILE = 'create_saved_file';
export const OPEN_FILE_DIALOG = 'open_file_dialog';
export const OPEN_FILE_FROM_OS = 'open_file_from_os';
export const ASK_TO_SAVE = 'ask_to_save';
export const LOAD_FILE = 'load_file';
export const SAVE_FILE_AS = 'save_file_as';
export const EXPORT_DIALOG = 'export_dialog';
export const EXPORT_FILES = 'export_files';
export const EXPORT_PRELOOP = 'export_preloop';
export const EXPORT_COLORS_SEPARATED = 'export_colors_separated';
export const CANCEL_EXPORT = 'cancel_export';
export const MAKE_COLOR_PALETTE_RGB = 'make_color_palette_rgb';
export const COLORIZE = 'colorize';
export const ANALYZE_CURRENT_FRAME = 'analyze_current_frame';
export const CANCEL_COLORIZATION = 'cancel_colorization';
export const SHOW_HELP = 'show_help';
export const OPEN_FEEDBACK_DIALOG = 'open_feedback_dialog';
export const HANDLE_IMAGE_DROP = 'handle_image_drop';
export const ADD_IMAGES_TO_TIMELINE = 'add_images_to_timeline';
export const IMPORT_FILES_LINES = 'import_files_lines';
export const IMPORT_FILES_COLOR = 'import_files_color';
export const IMPORT_FILES_FROM_MENU = 'import-files-from-menu';
export const TOGGLE_FRAME_SELECTION = 'toggle_frame_selection';
export const PLAYER_PLAY_PAUSE = 'player_play_pause';
export const FIND_REFERENCE_FRAMES_FOR_ALL_SELECTED_FRAMES = 'find_reference_frames_for_all_selected_frames';
export const HANDLE_DELETE_PRESS = 'handle_delete_press';
export const HANDLE_FRAME_DELETE = 'handle_frame_delete';
export const CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER = 'correct_originality_of_frames_on_layer';

// MODULE menu commands
export const SELECT_ALL_LINE_FRAMES_FROM_MENU = 'select-all-line-frames-frome-menu';
export const SELECT_ALL_COLOR_FRAMES_FROM_MENU = 'select-all-color-frames-frome-menu';
export const DESELECT_ALL_FRAMES_FROM_MENU = 'deselect-all-frames-frome-menu';
export const HANDLE_NEXT_UNIQUE_IMAGE = 'handle-next-unique-image';
export const HANDLE_PREVIOUS_UNIQUE_IMAGE = 'handle-previous-unique-image';

// MODULE ToolControls
export const ACTIVATE_TOOL_BY_ID = 'activate_tool_by_id';
export const ACTIVATE_PREVIOUS_TOOL = 'activate_previous_tool';
export const TOGGLE_ACTIVE_COLOR = 'toggle_active_color';

// MODULE ImageData
export const STORE_IMAGE_IN_IMAGE_STORE = 'store_image_data_in_image_store';
export const STORE_BLANK_IMAGE_IN_IMAGE_STORE = 'store_blank_image_in_image_store';
export const OVERWRITE_IMAGE_IN_IMAGE_STORE = 'overwrite_image_in_image_store';
export const CANVAS_ACTION = 'canvas_action';
export const UNDO_ACTION = 'undo_action';
export const REDO_ACTION = 'redo_action';
export const NEW_PROJECT = 'new_project';
export const URI_CHANGE_COLOR = 'uri_change_color';
export const REMOVE_MULTIPLE_COLOR_SWATCHES = 'remove_multiple_color_swatches';
export const SOLO_COLOR_IN_PALETTE = 'solo_color_in_palette';
export const POPULATE_PALETTE = 'populate_palette';

export const ADD_NEW_REFERENCE_IMAGE = 'add_new_reference_image';
export const LOAD_REFERENCE_FILE = 'load_reference_file';
export const DELETE_SELECTED_REFERENCE_IMAGES = 'delete_selected_reference_images';
export const TOGGLE_FRAME_ORIGINALITY = 'toggle_frame_originality';
export const CYCLE_SWATCH = 'cycle_swatch';
