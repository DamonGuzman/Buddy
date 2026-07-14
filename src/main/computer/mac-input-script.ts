/**
 * Runs in macOS's built-in JavaScript for Automation host (`osascript -l JavaScript`).
 * Requests arrive as a JSON argv value, never through shell interpolation.
 */
export const MAC_INPUT_SCRIPT = String.raw`
// Importing the concrete framework is important on current macOS: importing the
// umbrella ApplicationServices framework gives JXA an incorrect CGPoint ABI and
// crashes osascript when CGEventCreateMouseEvent receives a constructed point.
ObjC.import('stdlib');
ObjC.import('CoreGraphics');

var KEY_CODES = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11,
  Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25,
  '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, O: 31, U: 32, '[': 33,
  I: 34, P: 35, ENTER: 36, RETURN: 36, L: 37, J: 38, "'": 39, K: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, N: 45, M: 46, '.': 47, TAB: 48,
  SPACE: 49, BACKSPACE: 51, ESC: 53, ESCAPE: 53,
  CMD: 55, COMMAND: 55, META: 55, WIN: 55, SHIFT: 56, CAPSLOCK: 57,
  ALT: 58, OPTION: 58, CTRL: 59, CONTROL: 59, RIGHTSHIFT: 60,
  RIGHTALT: 61, RIGHTOPTION: 61, RIGHTCTRL: 62, RIGHTCONTROL: 62, FN: 63,
  F17: 64, F18: 79, F19: 80, F20: 90, F5: 96, F6: 97, F7: 98, F3: 99,
  F8: 100, F9: 101, F11: 103, F13: 105, F16: 106, F14: 107, F10: 109,
  F12: 111, F15: 113, HOME: 115, PAGEUP: 116, DELETE: 117, F4: 118,
  END: 119, F2: 120, PAGEDOWN: 121, F1: 122, LEFT: 123, RIGHT: 124,
  DOWN: 125, UP: 126
};

var MODIFIER_FLAGS = {
  55: $.kCGEventFlagMaskCommand,
  56: $.kCGEventFlagMaskShift,
  58: $.kCGEventFlagMaskAlternate,
  59: $.kCGEventFlagMaskControl,
  60: $.kCGEventFlagMaskShift,
  61: $.kCGEventFlagMaskAlternate,
  62: $.kCGEventFlagMaskControl
};

function release(event) {
  // JXA wraps returned CF objects and releases them when this one-shot process
  // exits. Explicit CFRelease double-frees these wrappers on current macOS.
  void event;
}

function postMouse(type, point, button, clickState) {
  var event = $.CGEventCreateMouseEvent(null, type, point, button);
  if (!event) throw new Error('could not create a macOS mouse event');
  if (clickState) {
    $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clickState);
  }
  $.CGEventPost($.kCGHIDEventTap, event);
  release(event);
}

function move(request) {
  postMouse(
    $.kCGEventMouseMoved,
    $.CGPointMake(request.x, request.y),
    $.kCGMouseButtonLeft,
    0
  );
}

function click(request) {
  var point = $.CGPointMake(request.x, request.y);
  var button = $.kCGMouseButtonLeft;
  var down = $.kCGEventLeftMouseDown;
  var up = $.kCGEventLeftMouseUp;
  if (request.button === 'right') {
    button = $.kCGMouseButtonRight;
    down = $.kCGEventRightMouseDown;
    up = $.kCGEventRightMouseUp;
  } else if (request.button === 'middle') {
    button = $.kCGMouseButtonCenter;
    down = $.kCGEventOtherMouseDown;
    up = $.kCGEventOtherMouseUp;
  }
  postMouse($.kCGEventMouseMoved, point, button, 0);
  for (var i = 0; i < request.count; i += 1) {
    postMouse(down, point, button, i + 1);
    postMouse(up, point, button, i + 1);
  }
}

function scroll(request) {
  var event = $.CGEventCreateScrollWheelEvent(
    null,
    $.kCGScrollEventUnitPixel,
    2,
    request.deltaY,
    request.deltaX
  );
  if (!event) throw new Error('could not create a macOS scroll event');
  $.CGEventPost($.kCGHIDEventTap, event);
  release(event);
}

function typeText(request) {
  var characters = Array.from(request.text);
  for (var offset = 0; offset < characters.length; offset += 20) {
    var chunk = characters.slice(offset, offset + 20).join('');
    var down = $.CGEventCreateKeyboardEvent(null, 0, true);
    var up = $.CGEventCreateKeyboardEvent(null, 0, false);
    if (!down || !up) {
      release(down);
      release(up);
      throw new Error('could not create a macOS text event');
    }
    $.CGEventKeyboardSetUnicodeString(down, chunk.length, chunk);
    $.CGEventKeyboardSetUnicodeString(up, chunk.length, chunk);
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
    release(down);
    release(up);
  }
}

function postKey(code, isDown, flags) {
  var event = $.CGEventCreateKeyboardEvent(null, code, isDown);
  if (!event) throw new Error('could not create a macOS key event');
  $.CGEventSetFlags(event, flags);
  $.CGEventPost($.kCGHIDEventTap, event);
  release(event);
}

function pressKeys(request) {
  var codes = request.keys.map(function (raw) {
    var name = String(raw).trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(KEY_CODES, name)) {
      throw new Error('unsupported key: ' + raw);
    }
    return KEY_CODES[name];
  });
  var flags = 0;
  codes.forEach(function (code) {
    if (Object.prototype.hasOwnProperty.call(MODIFIER_FLAGS, code)) flags |= MODIFIER_FLAGS[code];
    postKey(code, true, flags);
  });
  for (var i = codes.length - 1; i >= 0; i -= 1) {
    var code = codes[i];
    postKey(code, false, flags);
    if (Object.prototype.hasOwnProperty.call(MODIFIER_FLAGS, code)) flags &= ~MODIFIER_FLAGS[code];
  }
}

function run(argv) {
  if (argv.length !== 1) throw new Error('expected one input request');
  var request = JSON.parse(argv[0]);
  switch (request.action) {
    case 'move': move(request); break;
    case 'click': click(request); break;
    case 'scroll': scroll(request); break;
    case 'type_text': typeText(request); break;
    case 'press_keys': pressKeys(request); break;
    default: throw new Error('unknown input action');
  }
  return JSON.stringify({ ok: true });
}
`;
