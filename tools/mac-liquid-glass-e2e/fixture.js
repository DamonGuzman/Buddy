'use strict';

/* global document, window */

window.__buddyEvents = { mouseDown: 0, keyDown: 0, input: 0, scroll: 0 };
document.addEventListener('mousedown', () => {
  window.__buddyEvents.mouseDown += 1;
});
document.addEventListener('keydown', () => {
  window.__buddyEvents.keyDown += 1;
});
document.addEventListener('input', () => {
  window.__buddyEvents.input += 1;
});
document.addEventListener(
  'scroll',
  () => {
    window.__buddyEvents.scroll += 1;
  },
  true,
);
