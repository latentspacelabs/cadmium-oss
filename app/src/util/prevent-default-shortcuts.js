import store from '../store';

window.addEventListener('keydown', (e) => {
  if (store.state.colorizationInProgress) {
    // Block Ctrl/Cmd+A (Select All)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
    }
  }
});
