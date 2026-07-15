#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stddef.h>

/*
 * Minimal Node-API declarations keep this bridge independent of a
 * machine-specific Node/Electron header download. Node-API symbols are
 * resolved from Electron at load time (`-undefined dynamic_lookup`).
 */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
extern napi_status napi_create_double(napi_env env, double value, napi_value *result);
extern napi_status napi_get_value_double(napi_env env, napi_value value, double *result);
extern napi_status napi_get_value_string_utf8(
  napi_env env,
  napi_value value,
  char *buf,
  size_t bufsize,
  size_t *result
);
extern napi_status napi_get_buffer_info(
  napi_env env,
  napi_value value,
  void **data,
  size_t *length
);
extern napi_status napi_create_string_utf8(
  napi_env env,
  const char *str,
  size_t length,
  napi_value *result
);
extern napi_status napi_create_object(napi_env env, napi_value *result);
extern napi_status napi_get_null(napi_env env, napi_value *result);
extern napi_status napi_get_cb_info(
  napi_env env,
  napi_callback_info info,
  size_t *argc,
  napi_value *argv,
  napi_value *this_arg,
  void **data
);
extern napi_status napi_create_function(
  napi_env env,
  const char *utf8name,
  size_t length,
  napi_callback cb,
  void *data,
  napi_value *result
);
extern napi_status napi_set_named_property(
  napi_env env,
  napi_value object,
  const char *utf8name,
  napi_value value
);

static void set_number(napi_env env, napi_value object, const char *name, double value) {
  napi_value number = NULL;
  if (napi_create_double(env, value, &number) == 0) {
    napi_set_named_property(env, object, name, number);
  }
}

static void set_boolean(napi_env env, napi_value object, const char *name, bool value) {
  napi_value boolean = NULL;
  if (napi_get_boolean(env, value, &boolean) == 0) {
    napi_set_named_property(env, object, name, boolean);
  }
}

static napi_value json_string(napi_env env, NSDictionary *payload) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  napi_value result = NULL;
  if (data == nil || napi_create_string_utf8(
        env,
        data.bytes,
        data.length,
        &result
      ) != 0) {
    napi_create_string_utf8(env, "{\"error\":\"serialization_failed\",\"candidates\":[]}", (size_t)-1, &result);
  }
  return result;
}

static NSString *copy_ax_string(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || value == NULL) {
    return nil;
  }
  NSString *result = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    NSString *string = (__bridge NSString *)value;
    NSString *trimmed = [string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length > 0) result = [trimmed copy];
  } else if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    result = [(__bridge NSNumber *)value stringValue];
  }
  CFRelease(value);
  return result;
}

static bool copy_ax_rect(AXUIElementRef element, CGRect *rect) {
  CFTypeRef position_value = NULL;
  CFTypeRef size_value = NULL;
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  bool ok =
    AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &position_value) == kAXErrorSuccess &&
    position_value != NULL &&
    CFGetTypeID(position_value) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)position_value, kAXValueTypeCGPoint, &position) &&
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size_value) == kAXErrorSuccess &&
    size_value != NULL &&
    CFGetTypeID(size_value) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)size_value, kAXValueTypeCGSize, &size);
  if (position_value != NULL) CFRelease(position_value);
  if (size_value != NULL) CFRelease(size_value);
  if (!ok || !isfinite(position.x) || !isfinite(position.y) ||
      !isfinite(size.width) || !isfinite(size.height) || size.width <= 0 || size.height <= 0) {
    return false;
  }
  *rect = CGRectMake(position.x, position.y, size.width, size.height);
  return true;
}

static NSArray<NSDictionary *> *visible_window_scene(pid_t exclude_pid, CGRect search_rect) {
  CFArrayRef list = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (list == NULL) return @[];
  NSMutableArray<NSDictionary *> *windows = [NSMutableArray array];
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count && windows.count < 24; i++) {
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(list, i);
    pid_t pid = [info[(id)kCGWindowOwnerPID] intValue];
    NSInteger layer = [info[(id)kCGWindowLayer] integerValue];
    CGFloat alpha = [info[(id)kCGWindowAlpha] doubleValue];
    if (pid <= 0 || pid == exclude_pid || layer < 0 || layer > 25 || alpha <= 0.01) continue;
    CGRect bounds = CGRectZero;
    CFDictionaryRef bounds_dict = (__bridge CFDictionaryRef)info[(id)kCGWindowBounds];
    if (bounds_dict == NULL || !CGRectMakeWithDictionaryRepresentation(bounds_dict, &bounds) ||
        bounds.size.width <= 1 || bounds.size.height <= 1 || !CGRectIntersectsRect(bounds, search_rect)) {
      continue;
    }
    [windows addObject:@{
      @"pid": @(pid),
      @"rank": @(i),
      @"x": @(bounds.origin.x),
      @"y": @(bounds.origin.y),
      @"w": @(bounds.size.width),
      @"h": @(bounds.size.height),
    }];
  }
  CFRelease(list);
  return windows;
}

static NSString *best_ax_name(AXUIElementRef element) {
  for (NSString *attribute in @[
    (__bridge NSString *)kAXTitleAttribute,
    (__bridge NSString *)kAXDescriptionAttribute,
    (__bridge NSString *)kAXHelpAttribute,
    @"AXPlaceholderValue",
  ]) {
    NSString *value = copy_ax_string(element, (__bridge CFStringRef)attribute);
    if (value.length > 0) return value;
  }
  return nil;
}

/**
 * Enumerate named AX elements from the visible apps whose on-screen windows
 * intersect the search radius. CGWindowList is front-to-back, so split-view,
 * overlapping windows, and small model drift across an app boundary all get
 * bounded candidate coverage without assuming one frontmost application.
 *
 * Input/output are JSON strings to keep the Node-API ABI tiny:
 *   {x,y,radius,budgetMs,maxNodes,excludePid} -> {candidates,...}
 * Coordinates are global macOS screen points (Electron global DIP).
 */
static napi_value query_accessibility(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  size_t input_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &input_length) != 0 ||
      input_length == 0 || input_length > 65536) {
    return json_string(env, @{ @"error": @"invalid_request", @"candidates": @[] });
  }
  char *input_buffer = calloc(input_length + 1, 1);
  if (input_buffer == NULL ||
      napi_get_value_string_utf8(env, argv[0], input_buffer, input_length + 1, &input_length) != 0) {
    free(input_buffer);
    return json_string(env, @{ @"error": @"invalid_request", @"candidates": @[] });
  }

  @autoreleasepool {
    NSData *input_data = [NSData dataWithBytesNoCopy:input_buffer length:input_length freeWhenDone:YES];
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input_data options:0 error:nil];
    if (![request isKindOfClass:NSDictionary.class]) {
      return json_string(env, @{ @"error": @"invalid_request", @"candidates": @[] });
    }
    if (!AXIsProcessTrusted()) {
      return json_string(env, @{ @"error": @"accessibility_permission_required", @"candidates": @[] });
    }

    CGFloat x = [request[@"x"] doubleValue];
    CGFloat y = [request[@"y"] doubleValue];
    CGFloat radius = MAX(40, MIN(1400, [request[@"radius"] doubleValue] ?: 350));
    NSInteger budget_ms = MAX(100, MIN(2000, [request[@"budgetMs"] integerValue] ?: 500));
    NSInteger max_nodes = MAX(100, MIN(10000, [request[@"maxNodes"] integerValue] ?: 3500));
    pid_t exclude_pid = [request[@"excludePid"] intValue];
    if (!isfinite(x) || !isfinite(y)) {
      return json_string(env, @{ @"error": @"invalid_request", @"candidates": @[] });
    }

    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    CFAbsoluteTime deadline = started + ((double)budget_ms / 1000.0);
    CGRect search_rect = CGRectMake(x - radius, y - radius, 2 * radius, 2 * radius);
    NSArray<NSDictionary *> *windows = visible_window_scene(exclude_pid, search_rect);
    NSMutableArray<NSNumber *> *pids = [NSMutableArray array];
    NSMutableDictionary<NSNumber *, NSNumber *> *rank_by_pid = [NSMutableDictionary dictionary];
    for (NSDictionary *window in windows) {
      NSNumber *pid = window[@"pid"];
      if (rank_by_pid[pid] != nil) continue;
      rank_by_pid[pid] = @([rank_by_pid count]);
      [pids addObject:pid];
      if (pids.count >= 6) break;
    }

    NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
    NSInteger visited = 0;
    for (NSUInteger app_index = 0; app_index < pids.count; app_index++) {
      NSNumber *pid_number = pids[app_index];
      if (CFAbsoluteTimeGetCurrent() >= deadline || visited >= max_nodes || candidates.count >= 96) break;
      NSInteger apps_left = MAX(1, (NSInteger)pids.count - (NSInteger)app_index);
      NSInteger app_node_budget = MAX(350, (max_nodes - visited) / apps_left);
      NSInteger app_visited = 0;
      NSUInteger app_candidate_start = candidates.count;
      CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
      CFAbsoluteTime app_deadline = MIN(deadline, now + MAX(0.05, (deadline - now) / apps_left));
      AXUIElementRef app = AXUIElementCreateApplication(pid_number.intValue);
      if (app == NULL) continue;
      AXUIElementSetMessagingTimeout(app, MIN(0.12, MAX(0.03, app_deadline - now)));
      NSMutableArray<NSValue *> *stack = [NSMutableArray array];
      CFRetain(app);
      [stack addObject:[NSValue valueWithPointer:app]];
      while (stack.count > 0 && visited < max_nodes && app_visited < app_node_budget &&
             candidates.count < 96 && candidates.count - app_candidate_start < 32 &&
             CFAbsoluteTimeGetCurrent() < app_deadline) {
        AXUIElementRef element = (AXUIElementRef)stack.lastObject.pointerValue;
        [stack removeLastObject];
        visited += 1;
        app_visited += 1;

        CGRect rect = CGRectZero;
        bool has_rect = copy_ax_rect(element, &rect);
        if (has_rect && !CGRectIntersectsRect(rect, search_rect)) {
          CFRelease(element);
          continue;
        }

        NSString *role = copy_ax_string(element, kAXRoleAttribute);
        bool container = [role isEqualToString:(__bridge NSString *)kAXApplicationRole] ||
          [role isEqualToString:(__bridge NSString *)kAXWindowRole];
        if (has_rect && !container && rect.size.width >= 3 && rect.size.height >= 3 &&
            rect.size.width <= 2400 && rect.size.height <= 1200) {
          NSString *name = best_ax_name(element);
          if (name.length > 0) {
            NSString *control_type = [role hasPrefix:@"AX"] ? [role substringFromIndex:2] : (role ?: @"");
            [candidates addObject:@{
              @"name": name,
              @"ct": control_type,
              @"x": @(round(rect.origin.x)),
              @"y": @(round(rect.origin.y)),
              @"w": @(round(rect.size.width)),
              @"h": @(round(rect.size.height)),
              @"pid": pid_number,
              @"windowRank": rank_by_pid[pid_number] ?: @0,
            }];
          }
        }

        CFTypeRef children_value = NULL;
        if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children_value) == kAXErrorSuccess &&
            children_value != NULL && CFGetTypeID(children_value) == CFArrayGetTypeID()) {
          CFArrayRef children = (CFArrayRef)children_value;
          CFIndex child_count = MIN(CFArrayGetCount(children), 256);
          for (CFIndex i = child_count; i > 0; i--) {
            AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i - 1);
            if (child != NULL && CFGetTypeID(child) == AXUIElementGetTypeID()) {
              CFRetain(child);
              [stack addObject:[NSValue valueWithPointer:child]];
            }
          }
        }
        if (children_value != NULL) CFRelease(children_value);
        CFRelease(element);
      }
      for (NSValue *remaining in stack) {
        CFRelease((AXUIElementRef)remaining.pointerValue);
      }
      CFRelease(app);
    }

    [candidates sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
      CGFloat acx = [a[@"x"] doubleValue] + [a[@"w"] doubleValue] / 2;
      CGFloat acy = [a[@"y"] doubleValue] + [a[@"h"] doubleValue] / 2;
      CGFloat bcx = [b[@"x"] doubleValue] + [b[@"w"] doubleValue] / 2;
      CGFloat bcy = [b[@"y"] doubleValue] + [b[@"h"] doubleValue] / 2;
      CGFloat ad = hypot(acx - x, acy - y);
      CGFloat bd = hypot(bcx - x, bcy - y);
      return ad < bd ? NSOrderedAscending : ad > bd ? NSOrderedDescending : NSOrderedSame;
    }];
    if (candidates.count > 64) {
      [candidates removeObjectsInRange:NSMakeRange(64, candidates.count - 64)];
    }
    NSInteger elapsed_ms = (NSInteger)round((CFAbsoluteTimeGetCurrent() - started) * 1000);
    return json_string(env, @{
      @"elapsedMs": @(elapsed_ms),
      @"visited": @(visited),
      @"windows": @(windows.count),
      @"from": @"cgwindow+ax",
      @"candidates": candidates,
    });
  }
}

static napi_value request_screen_capture_access(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result = NULL;
  napi_get_boolean(env, CGRequestScreenCaptureAccess(), &result);
  return result;
}

static napi_value preflight_listen_event_access(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result = NULL;
  napi_get_boolean(env, CGPreflightListenEventAccess(), &result);
  return result;
}

static napi_value request_listen_event_access(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result = NULL;
  napi_get_boolean(env, CGRequestListenEventAccess(), &result);
  return result;
}

static NSScreen *screen_for_display_id(double requested_id) {
  for (NSScreen *screen in NSScreen.screens) {
    NSNumber *screen_number = screen.deviceDescription[@"NSScreenNumber"];
    if (screen_number != nil && screen_number.unsignedIntValue == (uint32_t)requested_id) {
      return screen;
    }
  }
  return nil;
}

static const void *buddy_full_display_key = &buddy_full_display_key;

static SEL buddy_original_constraint_selector(void) {
  return NSSelectorFromString(@"buddy_originalConstrainFrameRect:toScreen:");
}

static NSRect buddy_constrained_frame(
  id self,
  SEL selector,
  NSRect frame,
  NSScreen *screen
) {
  (void)selector;
  if ([objc_getAssociatedObject(self, buddy_full_display_key) boolValue]) return frame;
  SEL original_selector = buddy_original_constraint_selector();
  IMP original = class_getMethodImplementation(object_getClass(self), original_selector);
  if (original == NULL) return frame;
  typedef NSRect (*ConstraintFn)(id, SEL, NSRect, NSScreen *);
  return ((ConstraintFn)original)(self, original_selector, frame, screen);
}

/** Hook frame constraining once, then opt in only Buddy overlay instances. */
static bool make_overlay_window_unconstrained(NSWindow *window) {
  Class window_class = object_getClass(window);
  if (window_class == Nil) return false;
  @synchronized (window_class) {
    SEL selector = @selector(constrainFrameRect:toScreen:);
    SEL original_selector = buddy_original_constraint_selector();
    if (class_getInstanceMethod(window_class, original_selector) == NULL) {
      Method inherited = class_getInstanceMethod(window_class, selector);
      if (inherited == NULL || !class_addMethod(
            window_class,
            original_selector,
            method_getImplementation(inherited),
            method_getTypeEncoding(inherited)
          )) {
        return false;
      }
      class_replaceMethod(
        window_class,
        selector,
        (IMP)buddy_constrained_frame,
        method_getTypeEncoding(inherited)
      );
    }
  }
  objc_setAssociatedObject(
    window,
    buddy_full_display_key,
    @YES,
    OBJC_ASSOCIATION_RETAIN_NONATOMIC
  );
  return true;
}

/*
 * Electron intentionally clamps BrowserWindow y to the menu-bar height on
 * macOS, even for a non-activating panel. Buddy needs the overlay content to
 * begin at the physical screen edge so the Live Bar can join a hardware
 * notch. Apply the NSScreen frame through AppKit after Electron creates the
 * window, while reasserting the click-through/non-activating safety contract.
 */
static napi_value cover_display_with_window(napi_env env, napi_callback_info info) {
  napi_value result = NULL;
  napi_get_boolean(env, false, &result);
  size_t argc = 2;
  napi_value argv[2] = { NULL, NULL };
  void *buffer_data = NULL;
  size_t buffer_length = 0;
  double requested_id = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 2 ||
      napi_get_buffer_info(env, argv[0], &buffer_data, &buffer_length) != 0 ||
      buffer_data == NULL || buffer_length < sizeof(void *) ||
      napi_get_value_double(env, argv[1], &requested_id) != 0) {
    return result;
  }

  @autoreleasepool {
    NSView *view = (__bridge NSView *)(*(void **)buffer_data);
    NSWindow *window = view.window;
    NSScreen *matched = screen_for_display_id(requested_id);
    if (window == nil || matched == nil || !make_overlay_window_unconstrained(window)) return result;
    window.ignoresMouseEvents = YES;
    window.hasShadow = NO;
    [window setLevel:NSScreenSaverWindowLevel];
    [window setFrame:matched.frame display:YES];
    const bool covered = NSEqualRects(window.frame, matched.frame);
    napi_get_boolean(env, covered, &result);
    return result;
  }
}

/*
 * Return notch/menu-bar geometry for one CGDirectDisplayID. Electron's macOS
 * Display.id is the same WindowServer display id in current Chromium. The TS
 * wrapper treats a miss as a non-notched display and falls back to Electron's
 * workArea, so this bridge stays fail-soft if that mapping ever changes.
 */
static napi_value get_display_surface(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  double requested_id = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_value_double(env, argv[0], &requested_id) != 0) {
    napi_value null_value = NULL;
    napi_get_null(env, &null_value);
    return null_value;
  }

  @autoreleasepool {
    NSScreen *matched = screen_for_display_id(requested_id);

    if (matched == nil) {
      napi_value null_value = NULL;
      napi_get_null(env, &null_value);
      return null_value;
    }

    NSRect frame = matched.frame;
    NSRect visible = matched.visibleFrame;
    NSEdgeInsets safe = matched.safeAreaInsets;
    NSRect left = matched.auxiliaryTopLeftArea;
    NSRect right = matched.auxiliaryTopRightArea;
    const bool has_notch = safe.top > 0.5 && !NSIsEmptyRect(left) && !NSIsEmptyRect(right);
    const CGFloat notch_width = has_notch
      ? MAX(0, frame.size.width - left.size.width - right.size.width)
      : 0;
    const CGFloat menu_bar_height = MAX(0, NSMaxY(frame) - NSMaxY(visible));

    napi_value result = NULL;
    if (napi_create_object(env, &result) != 0) {
      napi_get_null(env, &result);
      return result;
    }
    set_number(env, result, "displayId", requested_id);
    set_boolean(env, result, "hasNotch", has_notch);
    set_number(env, result, "safeTop", safe.top);
    set_number(env, result, "notchWidth", notch_width);
    set_number(env, result, "menuBarHeight", menu_bar_height);
    return result;
  }
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  struct Export {
    const char *name;
    size_t length;
    napi_callback callback;
  } functions[] = {
    { "requestScreenCaptureAccess", 26, request_screen_capture_access },
    { "preflightListenEventAccess", 26, preflight_listen_event_access },
    { "requestListenEventAccess", 24, request_listen_event_access },
    { "coverDisplayWithWindow", 22, cover_display_with_window },
    { "getDisplaySurface", 17, get_display_surface },
    { "queryAccessibility", 18, query_accessibility },
  };

  for (size_t i = 0; i < sizeof(functions) / sizeof(functions[0]); i++) {
    napi_value function = NULL;
    if (napi_create_function(
          env,
          functions[i].name,
          functions[i].length,
          functions[i].callback,
          NULL,
          &function
        ) == 0) {
      napi_set_named_property(env, exports, functions[i].name, function);
    }
  }
  return exports;
}
