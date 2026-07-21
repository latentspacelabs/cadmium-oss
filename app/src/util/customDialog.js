import Vue from 'vue';
import CustomDialog from '@/components/CustomDialog.vue';

// Create a Vue instance for the dialog
let dialogInstance = null;
let isDialogOpen = false;

function cleanup() {
  if (dialogInstance) {
    dialogInstance.$destroy();
    dialogInstance.$el.remove();
    dialogInstance = null;
  }
  isDialogOpen = false;
}

export default function showCustomDialog(options) {
  return new Promise((resolve) => {
    // Prevent multiple dialogs from stacking
    if (isDialogOpen) {
      console.warn('Dialog already open, ignoring new dialog request:', options.title);
      resolve({ response: -1 }); // Return cancelled response
      return;
    }

    isDialogOpen = true;

    // Create a container for the dialog
    const container = document.createElement('div');
    document.body.appendChild(container);

    // Create a new Vue instance
    const DialogComponent = Vue.extend(CustomDialog);
    dialogInstance = new DialogComponent({
      propsData: {
        visible: true,
        title: options.title,
        message: options.message,
        detail: options.detail || '',
        buttons: options.buttons,
        defaultId: options.defaultId || 0,
        cancelId: options.cancelId || -1,
        type: options.type || 'info',
      },
    });

    // Mount the component
    dialogInstance.$mount(container);

    // Handle button clicks
    dialogInstance.$on('button-click', (result) => {
      if (options.onButtonClick) {
        options.onButtonClick(result, dialogInstance);
      } else {
        resolve(result);
        cleanup();
      }
    });

    // Handle close
    dialogInstance.$on('close', () => {
      resolve({ response: -1 });
      cleanup();
    });

    // Store reference for external access
    if (options.instanceCallback) {
      options.instanceCallback(dialogInstance);
    }
  });
}
