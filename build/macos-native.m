#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CommonCrypto/CommonDigest.h>
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
extern napi_status napi_throw_error(
  napi_env env,
  const char *code,
  const char *msg
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

static void set_string(napi_env env, napi_value object, const char *name, NSString *value) {
  napi_value string = NULL;
  if (napi_create_string_utf8(env, value.UTF8String, (size_t)-1, &string) == 0) {
    napi_set_named_property(env, object, name, string);
  }
}

static void set_null(napi_env env, napi_value object, const char *name) {
  napi_value nullValue = NULL;
  if (napi_get_null(env, &nullValue) == 0) {
    napi_set_named_property(env, object, name, nullValue);
  }
}

static void set_rect(napi_env env, napi_value object, const char *name, NSRect rect) {
  napi_value rectObject = NULL;
  if (napi_create_object(env, &rectObject) != 0) return;
  set_number(env, rectObject, "x", rect.origin.x);
  set_number(env, rectObject, "y", rect.origin.y);
  set_number(env, rectObject, "width", rect.size.width);
  set_number(env, rectObject, "height", rect.size.height);
  napi_set_named_property(env, object, name, rectObject);
}

static napi_value throw_liquid_glass_error(napi_env env, NSString *detail) {
  NSString *message = [@"macOS Liquid Glass: " stringByAppendingString:detail];
  napi_throw_error(env, "ERR_BUDDY_LIQUID_GLASS", message.UTF8String);
  return NULL;
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

@interface BuddyFocusedReceiver : NSObject
@property(nonatomic, assign, readonly) AXUIElementRef app;
@property(nonatomic, assign, readonly) AXUIElementRef window;
@property(nonatomic, assign, readonly) AXUIElementRef focus;
@property(nonatomic, assign, readonly) pid_t pid;
- (instancetype)initWithApp:(AXUIElementRef)app
                     window:(AXUIElementRef)window
                      focus:(AXUIElementRef)focus
                        pid:(pid_t)pid;
@end

@implementation BuddyFocusedReceiver
- (instancetype)initWithApp:(AXUIElementRef)app
                     window:(AXUIElementRef)window
                      focus:(AXUIElementRef)focus
                        pid:(pid_t)pid {
  self = [super init];
  if (self != nil) {
    _app = (AXUIElementRef)CFRetain(app);
    _window = (AXUIElementRef)CFRetain(window);
    _focus = (AXUIElementRef)CFRetain(focus);
    _pid = pid;
  }
  return self;
}
- (void)dealloc {
  if (_app != NULL) CFRelease(_app);
  if (_window != NULL) CFRelease(_window);
  if (_focus != NULL) CFRelease(_focus);
}
@end

static NSMutableDictionary<NSString *, BuddyFocusedReceiver *> *focused_receiver_tokens;
static NSMutableArray<NSString *> *focused_receiver_order;

@interface BuddyTypeTextProof : NSObject
@property(nonatomic, strong, readonly) BuddyFocusedReceiver *receiver;
@property(nonatomic, copy, readonly) NSData *expectedDigest;
@property(nonatomic, assign, readonly) NSUInteger expectedLength;
@property(nonatomic, assign, readonly) NSUInteger insertionEnd;
@property(nonatomic, assign, readonly) CFAbsoluteTime expiresAt;
- (instancetype)initWithReceiver:(BuddyFocusedReceiver *)receiver
                   expectedDigest:(NSData *)expectedDigest
                   expectedLength:(NSUInteger)expectedLength
                     insertionEnd:(NSUInteger)insertionEnd
                        expiresAt:(CFAbsoluteTime)expiresAt;
@end

@implementation BuddyTypeTextProof
- (instancetype)initWithReceiver:(BuddyFocusedReceiver *)receiver
                   expectedDigest:(NSData *)expectedDigest
                   expectedLength:(NSUInteger)expectedLength
                     insertionEnd:(NSUInteger)insertionEnd
                        expiresAt:(CFAbsoluteTime)expiresAt {
  self = [super init];
  if (self != nil) {
    _receiver = receiver;
    _expectedDigest = [expectedDigest copy];
    _expectedLength = expectedLength;
    _insertionEnd = insertionEnd;
    _expiresAt = expiresAt;
  }
  return self;
}
@end

static NSMutableDictionary<NSString *, BuddyTypeTextProof *> *type_text_proof_tokens;
static NSMutableArray<NSString *> *type_text_proof_order;

static NSString *retain_focused_receiver(
  AXUIElementRef app,
  AXUIElementRef window,
  AXUIElementRef focus,
  pid_t pid
) {
  @synchronized([BuddyFocusedReceiver class]) {
    if (focused_receiver_tokens == nil) {
      focused_receiver_tokens = [NSMutableDictionary dictionary];
      focused_receiver_order = [NSMutableArray array];
    }
    NSString *token = NSUUID.UUID.UUIDString;
    focused_receiver_tokens[token] = [[BuddyFocusedReceiver alloc]
      initWithApp:app window:window focus:focus pid:pid];
    [focused_receiver_order addObject:token];
    while (focused_receiver_order.count > 32) {
      NSString *expired = focused_receiver_order.firstObject;
      [focused_receiver_order removeObjectAtIndex:0];
      [focused_receiver_tokens removeObjectForKey:expired];
    }
    return token;
  }
}

static bool current_focus_matches_receiver(
  BuddyFocusedReceiver *receiver,
  AXUIElementRef *matched_focus
) {
  if (receiver == nil || receiver.pid <= 0 || !AXIsProcessTrusted()) return false;
  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (frontmost == nil || frontmost.processIdentifier != receiver.pid) return false;
  AXUIElementSetMessagingTimeout(receiver.app, 0.15);
  CFTypeRef window_value = NULL;
  CFTypeRef focus_value = NULL;
  AXError window_error = AXUIElementCopyAttributeValue(
    receiver.app, kAXFocusedWindowAttribute, &window_value
  );
  AXError focus_error = AXUIElementCopyAttributeValue(
    receiver.app, kAXFocusedUIElementAttribute, &focus_value
  );
  bool matches = window_error == kAXErrorSuccess && focus_error == kAXErrorSuccess &&
    window_value != NULL && focus_value != NULL &&
    CFGetTypeID(window_value) == AXUIElementGetTypeID() &&
    CFGetTypeID(focus_value) == AXUIElementGetTypeID() &&
    CFEqual(window_value, receiver.window) && CFEqual(focus_value, receiver.focus);
  if (window_value != NULL) CFRelease(window_value);
  if (!matches) {
    if (focus_value != NULL) CFRelease(focus_value);
    return false;
  }
  if (matched_focus != NULL) {
    *matched_focus = (AXUIElementRef)focus_value;
  } else {
    CFRelease(focus_value);
  }
  return true;
}

static bool copy_focused_text_state(
  AXUIElementRef focus,
  NSString **value,
  CFRange *selection
) {
  CFTypeRef value_attribute = NULL;
  CFTypeRef selection_attribute = NULL;
  AXError value_error = AXUIElementCopyAttributeValue(
    focus, kAXValueAttribute, &value_attribute
  );
  AXError selection_error = AXUIElementCopyAttributeValue(
    focus, kAXSelectedTextRangeAttribute, &selection_attribute
  );
  bool valid = value_error == kAXErrorSuccess && selection_error == kAXErrorSuccess &&
    value_attribute != NULL && selection_attribute != NULL &&
    CFGetTypeID(value_attribute) == CFStringGetTypeID() &&
    CFGetTypeID(selection_attribute) == AXValueGetTypeID() &&
    AXValueGetType((AXValueRef)selection_attribute) == kAXValueCFRangeType &&
    AXValueGetValue((AXValueRef)selection_attribute, kAXValueCFRangeType, selection);
  if (valid) {
    NSString *string = (__bridge NSString *)value_attribute;
    valid = selection->location >= 0 && selection->length >= 0 &&
      (NSUInteger)selection->location <= string.length &&
      (NSUInteger)selection->length <= string.length - (NSUInteger)selection->location;
    if (valid) *value = [string copy];
  }
  if (value_attribute != NULL) CFRelease(value_attribute);
  if (selection_attribute != NULL) CFRelease(selection_attribute);
  return valid;
}

static void remove_expired_type_text_proofs(CFAbsoluteTime now) {
  for (NSInteger index = (NSInteger)type_text_proof_order.count - 1; index >= 0; index--) {
    NSString *token = type_text_proof_order[(NSUInteger)index];
    BuddyTypeTextProof *proof = type_text_proof_tokens[token];
    if (proof == nil || proof.expiresAt <= now) {
      [type_text_proof_order removeObjectAtIndex:(NSUInteger)index];
      [type_text_proof_tokens removeObjectForKey:token];
    }
  }
}

static void remove_type_text_proof(NSString *token, BuddyTypeTextProof *proof) {
  @synchronized([BuddyTypeTextProof class]) {
    if (type_text_proof_tokens[token] != proof) return;
    [type_text_proof_tokens removeObjectForKey:token];
    [type_text_proof_order removeObject:token];
  }
}

static NSString *retain_type_text_proof(
  BuddyFocusedReceiver *receiver,
  NSData *expected_digest,
  NSUInteger expected_length,
  NSUInteger insertion_end
) {
  @synchronized([BuddyTypeTextProof class]) {
    if (type_text_proof_tokens == nil) {
      type_text_proof_tokens = [NSMutableDictionary dictionary];
      type_text_proof_order = [NSMutableArray array];
    }
    remove_expired_type_text_proofs(CFAbsoluteTimeGetCurrent());
    NSString *token = NSUUID.UUID.UUIDString;
    type_text_proof_tokens[token] = [[BuddyTypeTextProof alloc]
      initWithReceiver:receiver
      expectedDigest:expected_digest
      expectedLength:expected_length
      insertionEnd:insertion_end
      expiresAt:CFAbsoluteTimeGetCurrent() + 2.0];
    [type_text_proof_order addObject:token];
    while (type_text_proof_order.count > 32) {
      NSString *expired = type_text_proof_order.firstObject;
      [type_text_proof_order removeObjectAtIndex:0];
      [type_text_proof_tokens removeObjectForKey:expired];
    }
    return token;
  }
}

static NSData *digest_utf16_string(NSString *value) {
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1) return nil;
  UniChar buffer[1024];
  NSUInteger offset = 0;
  while (offset < value.length) {
    NSUInteger length = MIN((NSUInteger)1024, value.length - offset);
    [value getCharacters:buffer range:NSMakeRange(offset, length)];
    if (CC_SHA256_Update(&context, buffer, (CC_LONG)(length * sizeof(UniChar))) != 1) {
      return nil;
    }
    offset += length;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256_Final(digest, &context) != 1) return nil;
  return [NSData dataWithBytes:digest length:sizeof(digest)];
}

/** Bounded native identity of the receiver that would get keyboard input. */
static napi_value query_focused_receiver(napi_env env, napi_callback_info info) {
  (void)info;
  @autoreleasepool {
    if (!AXIsProcessTrusted()) {
      return json_string(env, @{ @"error": @"accessibility_permission_required" });
    }
    NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
    pid_t pid = frontmost.processIdentifier;
    if (frontmost == nil || pid <= 0) {
      return json_string(env, @{ @"error": @"focused_application_unavailable" });
    }
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (app == NULL) {
      return json_string(env, @{ @"error": @"focused_application_unavailable" });
    }
    AXUIElementSetMessagingTimeout(app, 0.15);

    CFTypeRef window_value = NULL;
    CFTypeRef focus_value = NULL;
    AXError window_error = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window_value);
    AXError focus_error = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focus_value);
    if (window_error != kAXErrorSuccess || focus_error != kAXErrorSuccess ||
        window_value == NULL || focus_value == NULL ||
        CFGetTypeID(window_value) != AXUIElementGetTypeID() ||
        CFGetTypeID(focus_value) != AXUIElementGetTypeID()) {
      if (window_value != NULL) CFRelease(window_value);
      if (focus_value != NULL) CFRelease(focus_value);
      CFRelease(app);
      return json_string(env, @{ @"error": @"focused_receiver_unavailable" });
    }
    AXUIElementRef window = (AXUIElementRef)window_value;
    AXUIElementRef focus = (AXUIElementRef)focus_value;
    CGRect window_rect = CGRectZero;
    CGRect focus_rect = CGRectZero;
    NSString *role = copy_ax_string(focus, kAXRoleAttribute);
    if (pid <= 0 || role.length == 0 || !copy_ax_rect(window, &window_rect) ||
        !copy_ax_rect(focus, &focus_rect)) {
      CFRelease(window_value);
      CFRelease(focus_value);
      CFRelease(app);
      return json_string(env, @{ @"error": @"focused_receiver_incomplete" });
    }
    NSString *identifier = copy_ax_string(focus, CFSTR("AXIdentifier")) ?: @"";
    NSString *window_identifier = copy_ax_string(window, CFSTR("AXIdentifier")) ?: @"";
    NSString *window_title = copy_ax_string(window, kAXTitleAttribute) ?: @"";
    NSString *restore_token = retain_focused_receiver(app, window, focus, pid);
    NSDictionary *payload = @{
      @"pid": @(pid),
      @"restoreToken": restore_token,
      @"window": @{
        @"identifier": window_identifier,
        @"title": window_title,
        @"x": @(round(window_rect.origin.x)), @"y": @(round(window_rect.origin.y)),
        @"w": @(round(window_rect.size.width)), @"h": @(round(window_rect.size.height)),
      },
      @"focus": @{
        @"role": role,
        @"identifier": identifier,
        @"x": @(round(focus_rect.origin.x)), @"y": @(round(focus_rect.origin.y)),
        @"w": @(round(focus_rect.size.width)), @"h": @(round(focus_rect.size.height)),
      },
    };
    CFRelease(window_value);
    CFRelease(focus_value);
    CFRelease(app);
    return json_string(env, payload);
  }
}

/** Restore the exact retained application/window/focused AX element. */
static napi_value restore_focused_receiver(napi_env env, napi_callback_info info) {
  napi_value result = NULL;
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  size_t token_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &token_length) != 0 ||
      token_length == 0 || token_length > 128) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  char token_buffer[129] = { 0 };
  if (napi_get_value_string_utf8(
        env, argv[0], token_buffer, sizeof(token_buffer), &token_length
      ) != 0) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  @autoreleasepool {
    NSString *token = [[NSString alloc] initWithBytes:token_buffer
                                               length:token_length
                                             encoding:NSUTF8StringEncoding];
    BuddyFocusedReceiver *receiver = nil;
    @synchronized([BuddyFocusedReceiver class]) {
      receiver = focused_receiver_tokens[token];
    }
    if (receiver == nil || receiver.pid <= 0 || !AXIsProcessTrusted()) {
      napi_get_boolean(env, false, &result);
      return result;
    }
    NSRunningApplication *application =
      [NSRunningApplication runningApplicationWithProcessIdentifier:receiver.pid];
    if (application == nil || application.terminated ||
        ![application activateWithOptions:NSApplicationActivateIgnoringOtherApps]) {
      napi_get_boolean(env, false, &result);
      return result;
    }
    AXUIElementSetMessagingTimeout(receiver.app, 0.15);
    // AX implementations vary in which focus setters they expose. Issue all
    // exact-handle operations; the caller then re-queries and requires a byte-
    // identical canonical identity before input can dispatch.
    AXUIElementPerformAction(receiver.window, kAXRaiseAction);
    AXUIElementSetAttributeValue(receiver.app, kAXFocusedWindowAttribute, receiver.window);
    AXUIElementSetAttributeValue(receiver.app, kAXFocusedUIElementAttribute, receiver.focus);
    napi_get_boolean(env, true, &result);
    return result;
  }
}

/** Prepare an opaque, receiver-bound postcondition for a text insertion. */
static napi_value prepare_focused_receiver_type_text(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  size_t input_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &input_length) != 0 ||
      input_length == 0 || input_length > 65536) {
    return json_string(env, @{ @"ok": @NO, @"error": @"invalid_request" });
  }
  char *input_buffer = calloc(input_length + 1, 1);
  if (input_buffer == NULL ||
      napi_get_value_string_utf8(env, argv[0], input_buffer, input_length + 1, &input_length) != 0) {
    free(input_buffer);
    return json_string(env, @{ @"ok": @NO, @"error": @"invalid_request" });
  }
  @autoreleasepool {
    NSData *data = [NSData dataWithBytesNoCopy:input_buffer length:input_length freeWhenDone:YES];
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![parsed isKindOfClass:NSDictionary.class]) {
      return json_string(env, @{ @"ok": @NO, @"error": @"invalid_request" });
    }
    NSDictionary *request = parsed;
    NSString *restore_token = request[@"restoreToken"];
    NSString *text = request[@"text"];
    if (![restore_token isKindOfClass:NSString.class] || restore_token.length == 0 ||
        restore_token.length > 128 || ![text isKindOfClass:NSString.class] ||
        text.length == 0 || text.length > 10000) {
      return json_string(env, @{ @"ok": @NO, @"error": @"invalid_request" });
    }
    BuddyFocusedReceiver *receiver = nil;
    @synchronized([BuddyFocusedReceiver class]) {
      receiver = focused_receiver_tokens[restore_token];
    }
    AXUIElementRef focus = NULL;
    if (!current_focus_matches_receiver(receiver, &focus)) {
      return json_string(env, @{ @"ok": @NO, @"error": @"receiver_mismatch" });
    }
    NSString *current_value = nil;
    CFRange selection = CFRangeMake(0, 0);
    bool has_state = copy_focused_text_state(focus, &current_value, &selection);
    CFRelease(focus);
    if (!has_state) {
      return json_string(env, @{ @"ok": @NO, @"error": @"text_state_unavailable" });
    }
    // Bound transient memory while handling documents whose AXValue may expose
    // their entire contents. The proof itself stores only a one-way digest.
    if (current_value.length > 1000000 || current_value.length + text.length > 1000000) {
      return json_string(env, @{ @"ok": @NO, @"error": @"text_state_too_large" });
    }
    NSRange replacement = NSMakeRange(
      (NSUInteger)selection.location, (NSUInteger)selection.length
    );
    NSString *expected = [current_value stringByReplacingCharactersInRange:replacement
                                                                 withString:text];
    NSUInteger insertion_end = (NSUInteger)selection.location + text.length;
    NSData *expected_digest = digest_utf16_string(expected);
    if (expected_digest == nil) {
      return json_string(env, @{ @"ok": @NO, @"error": @"digest_failed" });
    }
    NSString *proof_token = retain_type_text_proof(
      receiver, expected_digest, expected.length, insertion_end
    );
    return json_string(env, @{ @"ok": @YES, @"proofToken": proof_token });
  }
}

/** Verify and consume a successful opaque text-insertion postcondition. */
static napi_value verify_focused_receiver_type_text(napi_env env, napi_callback_info info) {
  napi_value result = NULL;
  napi_get_boolean(env, false, &result);
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  size_t token_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &token_length) != 0 ||
      token_length == 0 || token_length > 128) {
    return result;
  }
  char token_buffer[129] = { 0 };
  if (napi_get_value_string_utf8(
        env, argv[0], token_buffer, sizeof(token_buffer), &token_length
      ) != 0) {
    return result;
  }
  @autoreleasepool {
    NSString *token = [[NSString alloc] initWithBytes:token_buffer
                                               length:token_length
                                             encoding:NSUTF8StringEncoding];
    BuddyTypeTextProof *proof = nil;
    @synchronized([BuddyTypeTextProof class]) {
      if (type_text_proof_tokens == nil) return result;
      remove_expired_type_text_proofs(CFAbsoluteTimeGetCurrent());
      proof = type_text_proof_tokens[token];
    }
    if (proof == nil) return result;
    AXUIElementRef focus = NULL;
    if (!current_focus_matches_receiver(proof.receiver, &focus)) {
      remove_type_text_proof(token, proof);
      return result;
    }
    NSString *current_value = nil;
    CFRange selection = CFRangeMake(0, 0);
    bool has_state = copy_focused_text_state(focus, &current_value, &selection);
    CFRelease(focus);
    if (!has_state) {
      remove_type_text_proof(token, proof);
      return result;
    }
    NSData *current_digest = current_value.length == proof.expectedLength
      ? digest_utf16_string(current_value)
      : nil;
    bool verified = current_digest != nil &&
      [current_digest isEqualToData:proof.expectedDigest] &&
      selection.location >= 0 && (NSUInteger)selection.location == proof.insertionEnd &&
      selection.length == 0;
    if (!verified) return result;
    remove_type_text_proof(token, proof);
    napi_get_boolean(env, true, &result);
    return result;
  }
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

static NSDictionary *input_failure(NSString *error) {
  return @{ @"ok": @NO, @"error": error };
}

static bool finite_number(id value, double *result) {
  if (![value isKindOfClass:NSNumber.class]) return false;
  double number = [value doubleValue];
  if (!isfinite(number)) return false;
  *result = number;
  return true;
}

static CGEventRef create_mouse_event(
  CGEventType type,
  CGPoint point,
  CGMouseButton button,
  int64_t click_state
) {
  CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, button);
  if (event == NULL) return NULL;
  if (click_state > 0) {
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_state);
  }
  return event;
}

static CGEventRef create_keyboard_event(CGKeyCode code, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
  if (event == NULL) return NULL;
  CGEventSetFlags(event, flags);
  return event;
}

static void release_events(CGEventRef *events, NSUInteger count) {
  for (NSUInteger index = 0; index < count; index++) {
    if (events[index] != NULL) CFRelease(events[index]);
  }
}

static NSDictionary<NSString *, NSNumber *> *mac_key_codes(void) {
  static NSDictionary<NSString *, NSNumber *> *codes;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    codes = @{
      @"A": @0, @"S": @1, @"D": @2, @"F": @3, @"H": @4, @"G": @5,
      @"Z": @6, @"X": @7, @"C": @8, @"V": @9, @"B": @11, @"Q": @12,
      @"W": @13, @"E": @14, @"R": @15, @"Y": @16, @"T": @17,
      @"1": @18, @"2": @19, @"3": @20, @"4": @21, @"6": @22, @"5": @23,
      @"=": @24, @"9": @25, @"7": @26, @"-": @27, @"8": @28, @"0": @29,
      @"]": @30, @"O": @31, @"U": @32, @"[": @33, @"I": @34, @"P": @35,
      @"ENTER": @36, @"RETURN": @36, @"L": @37, @"J": @38, @"'": @39,
      @"K": @40, @";": @41, @"\\": @42, @",": @43, @"/": @44, @"N": @45,
      @"M": @46, @".": @47, @"TAB": @48, @"SPACE": @49, @"BACKSPACE": @51,
      @"ESC": @53, @"ESCAPE": @53, @"CMD": @55, @"COMMAND": @55,
      @"META": @55, @"WIN": @55, @"SHIFT": @56, @"CAPSLOCK": @57,
      @"ALT": @58, @"OPTION": @58, @"CTRL": @59, @"CONTROL": @59,
      @"RIGHTSHIFT": @60, @"RIGHTALT": @61, @"RIGHTOPTION": @61,
      @"RIGHTCTRL": @62, @"RIGHTCONTROL": @62, @"FN": @63, @"F17": @64,
      @"F18": @79, @"F19": @80, @"F20": @90, @"F5": @96, @"F6": @97,
      @"F7": @98, @"F3": @99, @"F8": @100, @"F9": @101, @"F11": @103,
      @"F13": @105, @"F16": @106, @"F14": @107, @"F10": @109,
      @"F12": @111, @"F15": @113, @"HOME": @115, @"PAGEUP": @116,
      @"DELETE": @117, @"F4": @118, @"END": @119, @"F2": @120,
      @"PAGEDOWN": @121, @"F1": @122, @"LEFT": @123, @"RIGHT": @124,
      @"DOWN": @125, @"UP": @126,
    };
  });
  return codes;
}

static CGEventFlags modifier_flag(CGKeyCode code) {
  switch (code) {
    case 55: return kCGEventFlagMaskCommand;
    case 56: case 60: return kCGEventFlagMaskShift;
    case 58: case 61: return kCGEventFlagMaskAlternate;
    case 59: case 62: return kCGEventFlagMaskControl;
    default: return 0;
  }
}

static NSDictionary *perform_input_request(NSDictionary *request) {
  if (!AXIsProcessTrusted()) return input_failure(@"accessibility_permission_required");
  if (!CGPreflightPostEventAccess()) return input_failure(@"input_post_permission_required");
  NSString *action = request[@"action"];
  if (![action isKindOfClass:NSString.class]) return input_failure(@"invalid_action");

  if ([action isEqualToString:@"move"] || [action isEqualToString:@"click"]) {
    double x = 0;
    double y = 0;
    if (!finite_number(request[@"x"], &x) || !finite_number(request[@"y"], &y)) {
      return input_failure(@"invalid_coordinates");
    }
    CGPoint point = CGPointMake(round(x), round(y));
    if ([action isEqualToString:@"move"]) {
      CGEventRef event = create_mouse_event(
        kCGEventMouseMoved, point, kCGMouseButtonLeft, 0
      );
      if (event == NULL) return input_failure(@"event_creation_failed");
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
      return @{ @"ok": @YES };
    }

    NSString *button_name = request[@"button"];
    NSNumber *count_number = request[@"count"];
    NSInteger count = [count_number isKindOfClass:NSNumber.class] ? count_number.integerValue : 0;
    CGMouseButton button;
    CGEventType down;
    CGEventType up;
    if ([button_name isEqualToString:@"left"]) {
      button = kCGMouseButtonLeft; down = kCGEventLeftMouseDown; up = kCGEventLeftMouseUp;
    } else if ([button_name isEqualToString:@"right"]) {
      button = kCGMouseButtonRight; down = kCGEventRightMouseDown; up = kCGEventRightMouseUp;
    } else if ([button_name isEqualToString:@"middle"]) {
      button = kCGMouseButtonCenter; down = kCGEventOtherMouseDown; up = kCGEventOtherMouseUp;
    } else {
      return input_failure(@"invalid_mouse_button");
    }
    if (count != 1 && count != 2) return input_failure(@"invalid_click_count");
    CGEventRef events[5] = { NULL, NULL, NULL, NULL, NULL };
    NSUInteger event_count = 1 + (NSUInteger)count * 2;
    events[0] = create_mouse_event(kCGEventMouseMoved, point, button, 0);
    for (NSInteger index = 0; index < count; index++) {
      events[1 + (NSUInteger)index * 2] = create_mouse_event(down, point, button, index + 1);
      events[2 + (NSUInteger)index * 2] = create_mouse_event(up, point, button, index + 1);
    }
    for (NSUInteger index = 0; index < event_count; index++) {
      if (events[index] == NULL) {
        release_events(events, event_count);
        return input_failure(@"event_creation_failed");
      }
    }
    for (NSUInteger index = 0; index < event_count; index++) {
      CGEventPost(kCGHIDEventTap, events[index]);
    }
    release_events(events, event_count);
    return @{ @"ok": @YES };
  }

  if ([action isEqualToString:@"scroll"]) {
    double delta_x = 0;
    double delta_y = 0;
    if (!finite_number(request[@"deltaX"], &delta_x) ||
        !finite_number(request[@"deltaY"], &delta_y)) {
      return input_failure(@"invalid_scroll_delta");
    }
    CGEventRef event = CGEventCreateScrollWheelEvent(
      NULL, kCGScrollEventUnitPixel, 2, (int32_t)round(delta_y), (int32_t)round(delta_x)
    );
    if (event == NULL) return input_failure(@"event_creation_failed");
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return @{ @"ok": @YES };
  }

  if ([action isEqualToString:@"type_text"]) {
    NSString *text = request[@"text"];
    if (![text isKindOfClass:NSString.class] || text.length == 0 || text.length > 10000) {
      return input_failure(@"invalid_text");
    }
    NSUInteger capacity = 2 * ((text.length + 18) / 19);
    CGEventRef *events = calloc(capacity, sizeof(CGEventRef));
    if (events == NULL) return input_failure(@"event_allocation_failed");
    NSUInteger event_count = 0;
    NSUInteger offset = 0;
    while (offset < text.length) {
      NSUInteger length = MIN((NSUInteger)20, text.length - offset);
      if (offset + length < text.length && length > 0 &&
          CFStringIsSurrogateHighCharacter([text characterAtIndex:offset + length - 1])) {
        length -= 1;
      }
      if (length == 0) length = MIN((NSUInteger)2, text.length - offset);
      UniChar characters[20];
      [text getCharacters:characters range:NSMakeRange(offset, length)];
      CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
      CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
      if (down == NULL || up == NULL) {
        if (down != NULL) CFRelease(down);
        if (up != NULL) CFRelease(up);
        release_events(events, event_count);
        free(events);
        return input_failure(@"event_creation_failed");
      }
      CGEventKeyboardSetUnicodeString(down, length, characters);
      CGEventKeyboardSetUnicodeString(up, length, characters);
      events[event_count++] = down;
      events[event_count++] = up;
      offset += length;
    }
    for (NSUInteger index = 0; index < event_count; index++) {
      CGEventPost(kCGHIDEventTap, events[index]);
    }
    release_events(events, event_count);
    free(events);
    return @{ @"ok": @YES };
  }

  if ([action isEqualToString:@"press_keys"]) {
    NSArray *keys = request[@"keys"];
    if (![keys isKindOfClass:NSArray.class] || keys.count < 1 || keys.count > 8) {
      return input_failure(@"invalid_keys");
    }
    CGKeyCode codes[8];
    for (NSUInteger index = 0; index < keys.count; index++) {
      if (![keys[index] isKindOfClass:NSString.class]) return input_failure(@"invalid_keys");
      NSString *name = [keys[index] stringByTrimmingCharactersInSet:
        NSCharacterSet.whitespaceAndNewlineCharacterSet].uppercaseString;
      NSNumber *code = mac_key_codes()[name];
      if (code == nil) return input_failure([@"unsupported_key:" stringByAppendingString:name]);
      codes[index] = (CGKeyCode)code.unsignedShortValue;
    }
    CGEventFlags flags = 0;
    CGEventRef events[16] = {
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    };
    for (NSUInteger index = 0; index < keys.count; index++) {
      flags |= modifier_flag(codes[index]);
      events[index] = create_keyboard_event(codes[index], true, flags);
    }
    for (NSUInteger index = keys.count; index > 0; index--) {
      CGKeyCode code = codes[index - 1];
      events[keys.count + (keys.count - index)] = create_keyboard_event(code, false, flags);
      flags &= ~modifier_flag(code);
    }
    NSUInteger event_count = keys.count * 2;
    for (NSUInteger index = 0; index < event_count; index++) {
      if (events[index] == NULL) {
        release_events(events, event_count);
        return input_failure(@"event_creation_failed");
      }
    }
    for (NSUInteger index = 0; index < event_count; index++) {
      CGEventPost(kCGHIDEventTap, events[index]);
    }
    release_events(events, event_count);
    return @{ @"ok": @YES };
  }

  return input_failure(@"unknown_action");
}

/** Post global input from the signed Buddy process so TCC evaluates Buddy. */
static napi_value post_input(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  size_t input_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &input_length) != 0 ||
      input_length == 0 || input_length > 65536) {
    return json_string(env, input_failure(@"invalid_request"));
  }
  char *input_buffer = calloc(input_length + 1, 1);
  if (input_buffer == NULL ||
      napi_get_value_string_utf8(env, argv[0], input_buffer, input_length + 1, &input_length) != 0) {
    free(input_buffer);
    return json_string(env, input_failure(@"invalid_request"));
  }
  @autoreleasepool {
    NSData *data = [NSData dataWithBytesNoCopy:input_buffer length:input_length freeWhenDone:YES];
    id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![request isKindOfClass:NSDictionary.class]) {
      return json_string(env, input_failure(@"invalid_request"));
    }
    return json_string(env, perform_input_request(request));
  }
}

/*
 * macOS 26 Liquid Glass
 * ---------------------
 * Electron documents getNativeWindowHandle() as the NSWindow content NSView on
 * macOS. Keep that Electron-owned view alive and make it NSGlassEffectView's
 * designated contentView. This is the hierarchy AppKit requires for correct
 * foreground treatment; placing glass behind Chromium as a sibling is not
 * equivalent and is intentionally rejected here.
 */
static const void *buddy_liquid_glass_state_key = &buddy_liquid_glass_state_key;
static NSUInteger active_liquid_glass_state_count = 0;

API_AVAILABLE(macos(26.0))
@interface BuddyLiquidGlassOptions : NSObject
@property(nonatomic, assign) NSGlassEffectViewStyle style;
@property(nonatomic, assign) CGFloat cornerRadius;
@property(nonatomic, copy, nullable) NSColor *tintColor;
@end

@implementation BuddyLiquidGlassOptions
@end

API_AVAILABLE(macos(26.0))
@interface BuddyLiquidGlassState : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, strong) NSGlassEffectView *glassView;
@property(nonatomic, strong) NSView *electronView;
@property(nonatomic, strong, nullable) id closeObserver;
@property(nonatomic, assign) BOOL removing;
@property(nonatomic, assign) BOOL counted;
@property(nonatomic, assign) NSRect originalElectronFrame;
@property(nonatomic, assign) NSAutoresizingMaskOptions originalElectronAutoresizingMask;
@property(nonatomic, assign) NSWindowStyleMask originalWindowStyleMask;
@end

static void cleanup_liquid_glass_state(BuddyLiquidGlassState *state, BOOL restoreElectronView)
  API_AVAILABLE(macos(26.0));

@implementation BuddyLiquidGlassState
- (void)dealloc {
  if (_closeObserver != nil) {
    [NSNotificationCenter.defaultCenter removeObserver:_closeObserver];
  }
}
@end

static bool liquid_glass_is_supported(void) {
  if (@available(macOS 26.0, *)) {
    return NSClassFromString(@"NSGlassEffectView") != nil;
  }
  return false;
}

static NSColor *liquid_glass_color_from_hex(NSString *value) API_AVAILABLE(macos(26.0)) {
  if (![value isKindOfClass:NSString.class] || value.length != 9 ||
      ![value hasPrefix:@"#"]) {
    return nil;
  }
  NSString *digits = [value substringFromIndex:1];
  NSCharacterSet *invalid = [[NSCharacterSet
    characterSetWithCharactersInString:@"0123456789abcdefABCDEF"] invertedSet];
  if ([digits rangeOfCharacterFromSet:invalid].location != NSNotFound) return nil;

  unsigned int rgba = 0;
  NSScanner *scanner = [NSScanner scannerWithString:digits];
  if (![scanner scanHexInt:&rgba] || !scanner.isAtEnd) return nil;
  return [NSColor colorWithSRGBRed:((rgba >> 24) & 0xff) / 255.0
                            green:((rgba >> 16) & 0xff) / 255.0
                             blue:((rgba >> 8) & 0xff) / 255.0
                            alpha:(rgba & 0xff) / 255.0];
}

static BuddyLiquidGlassOptions *parse_liquid_glass_options(
  NSString *json,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSError *jsonError = nil;
  id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
  if (![value isKindOfClass:NSDictionary.class]) {
    *error = jsonError == nil ? @"options must be a JSON object" : @"options are not valid JSON";
    return nil;
  }

  NSDictionary *options = value;
  NSSet<NSString *> *allowed = [NSSet setWithArray:@[
    @"style", @"cornerRadius", @"tintColor",
  ]];
  for (id key in options) {
    if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
      *error = @"options contain an unknown property";
      return nil;
    }
  }
  if (options.count != allowed.count || options[@"style"] == nil ||
      options[@"cornerRadius"] == nil || options[@"tintColor"] == nil) {
    *error = @"options must contain style, cornerRadius, and tintColor";
    return nil;
  }

  NSString *style = options[@"style"];
  if (![style isKindOfClass:NSString.class]) {
    *error = @"style must be regular or clear";
    return nil;
  }
  NSGlassEffectViewStyle nativeStyle;
  if ([style isEqualToString:@"regular"]) {
    nativeStyle = NSGlassEffectViewStyleRegular;
  } else if ([style isEqualToString:@"clear"]) {
    nativeStyle = NSGlassEffectViewStyleClear;
  } else {
    *error = @"style must be regular or clear";
    return nil;
  }

  NSNumber *cornerRadius = options[@"cornerRadius"];
  if (![cornerRadius isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)cornerRadius) == CFBooleanGetTypeID() ||
      !isfinite(cornerRadius.doubleValue) || cornerRadius.doubleValue < 0 ||
      cornerRadius.doubleValue > 1000) {
    *error = @"cornerRadius must be a finite number from 0 through 1000";
    return nil;
  }

  id tintValue = options[@"tintColor"];
  NSColor *tintColor = nil;
  if (tintValue != NSNull.null) {
    tintColor = liquid_glass_color_from_hex(tintValue);
    if (tintColor == nil) {
      *error = @"tintColor must be null or #RRGGBBAA";
      return nil;
    }
  }

  BuddyLiquidGlassOptions *parsed = [[BuddyLiquidGlassOptions alloc] init];
  parsed.style = nativeStyle;
  parsed.cornerRadius = (CGFloat)cornerRadius.doubleValue;
  parsed.tintColor = tintColor;
  return parsed;
}

static bool validate_installed_liquid_glass_state(
  BuddyLiquidGlassState *state,
  NSWindow *window,
  NSView *providedView,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  if (state.window != window || state.removing) {
    *error = @"the native window is already being torn down";
    return false;
  }
  if (providedView != state.glassView && providedView != state.electronView) {
    *error = @"the native handle does not belong to the installed glass hierarchy";
    return false;
  }
  if (window.contentView != state.glassView ||
      state.glassView.contentView != state.electronView ||
      state.electronView.window != window) {
    *error = @"the Electron content hierarchy changed after glass installation";
    return false;
  }
  return true;
}

static void apply_liquid_glass_options(
  NSGlassEffectView *glassView,
  BuddyLiquidGlassOptions *options
) API_AVAILABLE(macos(26.0)) {
  glassView.style = options.style;
  glassView.cornerRadius = options.cornerRadius;
  glassView.tintColor = options.tintColor;
}

/*
 * Bounded Liquid Glass backgrounds for Chromium-rendered overlay popups.
 * AppKit glass siblings can composite above Chromium's hosted layer even when
 * their NSView order says otherwise. Keep the glass in a click-through child
 * window explicitly ordered below Electron so renderer text is never masked.
 */
static const void *buddy_liquid_glass_regions_state_key =
  &buddy_liquid_glass_regions_state_key;
static NSUInteger active_liquid_glass_regions_state_count = 0;

API_AVAILABLE(macos(26.0))
@interface BuddyLiquidGlassRegionSpec : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, assign) NSRect topLeftRect;
@property(nonatomic, strong) BuddyLiquidGlassOptions *options;
@end

@implementation BuddyLiquidGlassRegionSpec
@end

API_AVAILABLE(macos(26.0))
@interface BuddyLiquidGlassRegionsPayload : NSObject
@property(nonatomic, assign) CGFloat spacing;
@property(nonatomic, copy) NSArray<BuddyLiquidGlassRegionSpec *> *regions;
@end

@implementation BuddyLiquidGlassRegionsPayload
@end

API_AVAILABLE(macos(26.0))
@interface BuddyLiquidGlassRegionsState : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, strong) NSWindow *backingWindow;
@property(nonatomic, strong) NSGlassEffectContainerView *containerView;
@property(nonatomic, strong) NSView *hostView;
@property(nonatomic, strong) NSView *electronView;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSGlassEffectView *> *regionViews;
@property(nonatomic, strong, nullable) id closeObserver;
@property(nonatomic, assign) BOOL removing;
@property(nonatomic, assign) BOOL counted;
@end

static void cleanup_liquid_glass_regions_state(
  BuddyLiquidGlassRegionsState *state
) API_AVAILABLE(macos(26.0));

@implementation BuddyLiquidGlassRegionsState
- (void)dealloc {
  if (_closeObserver != nil) {
    [NSNotificationCenter.defaultCenter removeObserver:_closeObserver];
  }
}
@end

static bool valid_region_number(id value, double minimum, double maximum) {
  return [value isKindOfClass:NSNumber.class] &&
    CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
    isfinite([value doubleValue]) && [value doubleValue] >= minimum &&
    [value doubleValue] <= maximum;
}

static BuddyLiquidGlassRegionsPayload *parse_liquid_glass_regions_payload(
  NSString *json,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class]) {
    *error = @"region payload must be a JSON object";
    return nil;
  }
  NSDictionary *payload = value;
  if (payload.count != 2 || payload[@"spacing"] == nil || payload[@"regions"] == nil) {
    *error = @"region payload must contain spacing and regions";
    return nil;
  }
  if (!valid_region_number(payload[@"spacing"], 0, 1000)) {
    *error = @"region spacing must be a finite number from 0 through 1000";
    return nil;
  }
  NSArray *regions = payload[@"regions"];
  if (![regions isKindOfClass:NSArray.class] || regions.count > 8) {
    *error = @"regions must be an array with at most 8 entries";
    return nil;
  }

  NSMutableSet<NSString *> *identifiers = [NSMutableSet set];
  NSMutableArray<BuddyLiquidGlassRegionSpec *> *parsed = [NSMutableArray array];
  NSSet<NSString *> *allowed = [NSSet setWithArray:@[
    @"id", @"x", @"y", @"width", @"height", @"style", @"cornerRadius", @"tintColor",
  ]];
  NSRegularExpression *identifierPattern = [NSRegularExpression
    regularExpressionWithPattern:@"^[a-z0-9][a-z0-9-]{0,63}$"
                         options:0
                           error:nil];
  for (id item in regions) {
    if (![item isKindOfClass:NSDictionary.class]) {
      *error = @"every region must be an object";
      return nil;
    }
    NSDictionary *region = item;
    if (region.count != allowed.count) {
      *error = @"every region must contain the complete region contract";
      return nil;
    }
    for (id key in region) {
      if (![key isKindOfClass:NSString.class] || ![allowed containsObject:key]) {
        *error = @"a region contains an unknown property";
        return nil;
      }
    }
    NSString *identifier = region[@"id"];
    if (![identifier isKindOfClass:NSString.class] ||
        [identifierPattern numberOfMatchesInString:identifier
                                           options:0
                                             range:NSMakeRange(0, identifier.length)] != 1 ||
        [identifiers containsObject:identifier]) {
      *error = @"region ids must be unique canonical identifiers";
      return nil;
    }
    if (!valid_region_number(region[@"x"], -20000, 20000) ||
        !valid_region_number(region[@"y"], -20000, 20000) ||
        !valid_region_number(region[@"width"], 0.01, 20000) ||
        !valid_region_number(region[@"height"], 0.01, 20000)) {
      *error = @"region geometry must contain finite positive dimensions";
      return nil;
    }

    NSDictionary *optionDictionary = @{
      @"style": region[@"style"],
      @"cornerRadius": region[@"cornerRadius"],
      @"tintColor": region[@"tintColor"],
    };
    NSData *optionData = [NSJSONSerialization dataWithJSONObject:optionDictionary options:0 error:nil];
    NSString *optionJSON = optionData == nil
      ? nil
      : [[NSString alloc] initWithData:optionData encoding:NSUTF8StringEncoding];
    BuddyLiquidGlassOptions *options = optionJSON == nil
      ? nil
      : parse_liquid_glass_options(optionJSON, error);
    if (options == nil) return nil;

    BuddyLiquidGlassRegionSpec *spec = [[BuddyLiquidGlassRegionSpec alloc] init];
    spec.identifier = identifier;
    spec.topLeftRect = NSMakeRect(
      [region[@"x"] doubleValue],
      [region[@"y"] doubleValue],
      [region[@"width"] doubleValue],
      [region[@"height"] doubleValue]
    );
    spec.options = options;
    [identifiers addObject:identifier];
    [parsed addObject:spec];
  }

  BuddyLiquidGlassRegionsPayload *result = [[BuddyLiquidGlassRegionsPayload alloc] init];
  result.spacing = [payload[@"spacing"] doubleValue];
  result.regions = parsed;
  return result;
}

static bool validate_liquid_glass_regions_state(
  BuddyLiquidGlassRegionsState *state,
  NSWindow *window,
  NSView *providedView,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  if (state.window != window || state.removing) {
    *error = @"the native region hierarchy is being torn down";
    return false;
  }
  if (providedView != state.electronView) {
    *error = @"the native handle does not belong to the region hierarchy";
    return false;
  }
  if (window.contentView != state.electronView || state.electronView.window != window ||
      state.backingWindow.parentWindow != window ||
      state.backingWindow.contentView != state.containerView ||
      state.containerView.contentView != state.hostView) {
    *error = @"the Electron region hierarchy changed after installation";
    return false;
  }
  return true;
}

static bool apply_liquid_glass_region_payload(
  BuddyLiquidGlassRegionsState *state,
  BuddyLiquidGlassRegionsPayload *payload,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  [state.backingWindow setFrame:state.window.frame display:NO];
  state.containerView.frame = NSMakeRect(
    0,
    0,
    state.backingWindow.contentLayoutRect.size.width,
    state.backingWindow.contentLayoutRect.size.height
  );
  state.hostView.frame = state.containerView.bounds;
  state.containerView.spacing = payload.spacing;
  NSMutableSet<NSString *> *desired = [NSMutableSet set];
  CGFloat hostHeight = state.hostView.bounds.size.height;
  for (BuddyLiquidGlassRegionSpec *spec in payload.regions) {
    NSRect top = spec.topLeftRect;
    if (top.origin.x < 0 || top.origin.y < 0 || NSMaxX(top) > state.hostView.bounds.size.width ||
        NSMaxY(top) > hostHeight) {
      *error = @"a region falls outside the overlay content bounds";
      return false;
    }
    [desired addObject:spec.identifier];
    NSGlassEffectView *glass = state.regionViews[spec.identifier];
    if (glass == nil) {
      glass = [[NSGlassEffectView alloc] initWithFrame:NSZeroRect];
      NSView *content = [[NSView alloc] initWithFrame:NSZeroRect];
      content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      glass.contentView = content;
      [state.hostView addSubview:glass];
      state.regionViews[spec.identifier] = glass;
    }
    apply_liquid_glass_options(glass, spec.options);
    glass.frame = NSMakeRect(
      top.origin.x,
      hostHeight - top.origin.y - top.size.height,
      top.size.width,
      top.size.height
    );
    glass.contentView.frame = glass.bounds;
  }
  for (NSString *identifier in [state.regionViews.allKeys copy]) {
    if (![desired containsObject:identifier]) {
      NSGlassEffectView *glass = state.regionViews[identifier];
      glass.contentView = nil;
      [glass removeFromSuperview];
      [state.regionViews removeObjectForKey:identifier];
    }
  }
  return true;
}

static void cleanup_liquid_glass_regions_state(
  BuddyLiquidGlassRegionsState *state
) {
  if (state == nil || state.removing) return;
  state.removing = YES;
  NSWindow *window = state.window;
  for (NSGlassEffectView *glass in state.regionViews.allValues) glass.contentView = nil;
  [state.regionViews removeAllObjects];
  state.containerView.contentView = nil;
  if (window != nil && state.backingWindow.parentWindow == window) {
    [window removeChildWindow:state.backingWindow];
  }
  [state.backingWindow orderOut:nil];
  [state.backingWindow close];
  if (window != nil &&
      objc_getAssociatedObject(window, buddy_liquid_glass_regions_state_key) == state) {
    objc_setAssociatedObject(
      window,
      buddy_liquid_glass_regions_state_key,
      nil,
      OBJC_ASSOCIATION_RETAIN_NONATOMIC
    );
  }
  if (state.counted) {
    if (active_liquid_glass_regions_state_count > 0) active_liquid_glass_regions_state_count -= 1;
    state.counted = NO;
  }
}

static bool set_liquid_glass_regions_on_main(
  NSView *providedView,
  BuddyLiquidGlassRegionsPayload *payload,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  NSWindow *window = providedView.window;
  if (window == nil) {
    *error = @"the native view is not attached to a window";
    return false;
  }
  if (objc_getAssociatedObject(window, buddy_liquid_glass_state_key) != nil) {
    *error = @"whole-window Liquid Glass is already installed";
    return false;
  }
  BuddyLiquidGlassRegionsState *state = objc_getAssociatedObject(
    window, buddy_liquid_glass_regions_state_key
  );
  if (state != nil) {
    if (!validate_liquid_glass_regions_state(state, window, providedView, error)) return false;
    return apply_liquid_glass_region_payload(state, payload, error);
  }
  if (window.contentView != providedView) {
    *error = @"Electron's native handle is not the NSWindow content view";
    return false;
  }

  state = [[BuddyLiquidGlassRegionsState alloc] init];
  state.window = window;
  state.electronView = providedView;
  state.regionViews = [NSMutableDictionary dictionary];
  state.backingWindow = [[NSWindow alloc]
    initWithContentRect:window.frame
              styleMask:NSWindowStyleMaskBorderless
                backing:NSBackingStoreBuffered
                  defer:NO];
  state.backingWindow.opaque = NO;
  state.backingWindow.backgroundColor = NSColor.clearColor;
  state.backingWindow.hasShadow = NO;
  state.backingWindow.ignoresMouseEvents = YES;
  state.backingWindow.releasedWhenClosed = NO;
  state.backingWindow.collectionBehavior =
    NSWindowCollectionBehaviorCanJoinAllSpaces |
    NSWindowCollectionBehaviorFullScreenAuxiliary |
    NSWindowCollectionBehaviorIgnoresCycle;
  state.containerView = [[NSGlassEffectContainerView alloc]
    initWithFrame:NSMakeRect(0, 0, window.frame.size.width, window.frame.size.height)];
  state.containerView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  state.hostView = [[NSView alloc] initWithFrame:state.containerView.bounds];
  state.hostView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  state.backingWindow.contentView = state.containerView;
  state.containerView.contentView = state.hostView;
  [window addChildWindow:state.backingWindow ordered:NSWindowBelow];

  if (window.contentView != state.electronView ||
      state.backingWindow.parentWindow != window ||
      state.backingWindow.contentView != state.containerView ||
      state.containerView.contentView != state.hostView || state.electronView.window != window) {
    cleanup_liquid_glass_regions_state(state);
    *error = @"AppKit did not preserve the required region hierarchy";
    return false;
  }
  if (!apply_liquid_glass_region_payload(state, payload, error)) {
    cleanup_liquid_glass_regions_state(state);
    return false;
  }

  objc_setAssociatedObject(
    window,
    buddy_liquid_glass_regions_state_key,
    state,
    OBJC_ASSOCIATION_RETAIN_NONATOMIC
  );
  active_liquid_glass_regions_state_count += 1;
  state.counted = YES;
  __weak BuddyLiquidGlassRegionsState *weakState = state;
  state.closeObserver = [NSNotificationCenter.defaultCenter
    addObserverForName:NSWindowWillCloseNotification
                object:window
                 queue:NSOperationQueue.mainQueue
            usingBlock:^(__unused NSNotification *notification) {
              cleanup_liquid_glass_regions_state(weakState);
            }];
  return true;
}

static void cleanup_liquid_glass_state(
  BuddyLiquidGlassState *state,
  BOOL restoreElectronView
) {
  if (state == nil || state.removing) return;
  state.removing = YES;

  NSWindow *window = state.window;
  NSRect currentWindowFrame = window == nil ? NSZeroRect : window.frame;
  NSRect currentGlassFrame = state.glassView.frame;
  if (state.glassView.contentView == state.electronView) {
    state.glassView.contentView = nil;
  }
  if (restoreElectronView && window != nil && window.contentView == state.glassView) {
    /* Reparent while full-size sizing is still active, then restore the window contract. */
    window.contentView = state.electronView;
    window.styleMask = state.originalWindowStyleMask;
    [window setFrame:currentWindowFrame display:NO];
    state.electronView.frame = NSMakeRect(
      state.originalElectronFrame.origin.x,
      state.originalElectronFrame.origin.y,
      currentGlassFrame.size.width,
      currentGlassFrame.size.height
    );
    state.electronView.autoresizingMask = state.originalElectronAutoresizingMask;
  }
  if (window != nil && objc_getAssociatedObject(window, buddy_liquid_glass_state_key) == state) {
    objc_setAssociatedObject(
      window,
      buddy_liquid_glass_state_key,
      nil,
      OBJC_ASSOCIATION_RETAIN_NONATOMIC
    );
  }
  if (state.counted) {
    if (active_liquid_glass_state_count > 0) active_liquid_glass_state_count -= 1;
    state.counted = NO;
  }
}

static bool install_liquid_glass_on_main(
  NSView *providedView,
  BuddyLiquidGlassOptions *options,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  NSWindow *window = providedView.window;
  if (window == nil) {
    *error = @"the native view is not attached to a window";
    return false;
  }
  if (objc_getAssociatedObject(window, buddy_liquid_glass_regions_state_key) != nil) {
    *error = @"bounded Liquid Glass regions are already installed";
    return false;
  }

  BuddyLiquidGlassState *existing = objc_getAssociatedObject(
    window, buddy_liquid_glass_state_key
  );
  if (existing != nil) {
    if (!validate_installed_liquid_glass_state(existing, window, providedView, error)) return false;
    apply_liquid_glass_options(existing.glassView, options);
    return true;
  }

  if (window.contentView != providedView) {
    *error = @"Electron's native handle is not the NSWindow content view";
    return false;
  }
  if ([providedView isKindOfClass:NSGlassEffectView.class]) {
    *error = @"the window already has an unmanaged glass content view";
    return false;
  }

  BuddyLiquidGlassState *state = [[BuddyLiquidGlassState alloc] init];
  state.window = window;
  state.electronView = providedView;
  state.originalElectronFrame = providedView.frame;
  state.originalElectronAutoresizingMask = providedView.autoresizingMask;
  state.originalWindowStyleMask = window.styleMask;
  state.glassView = [[NSGlassEffectView alloc] initWithFrame:providedView.frame];
  state.glassView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  apply_liquid_glass_options(state.glassView, options);

  /*
   * Electron's frameless NSWindow remains titled for rounded corners and its
   * Views root spans the titlebar area. A generic replacement content view is
   * otherwise constrained to contentLayoutRect (32 px shorter on macOS 26).
   * Use AppKit's public full-size-content contract while glass is installed.
   */
  window.styleMask = window.styleMask | NSWindowStyleMaskFullSizeContentView;
  /* NSWindow releases its old content view here; state retains Electron's root. */
  window.contentView = state.glassView;
  state.glassView.contentView = providedView;
  /* AppKit installs an internal content host when contentView is assigned. */
  providedView.frame = state.glassView.bounds;
  providedView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  if (window.contentView != state.glassView ||
      state.glassView.contentView != providedView || providedView.window != window) {
    cleanup_liquid_glass_state(state, YES);
    *error = @"AppKit did not preserve the required glass content hierarchy";
    return false;
  }

  objc_setAssociatedObject(
    window,
    buddy_liquid_glass_state_key,
    state,
    OBJC_ASSOCIATION_RETAIN_NONATOMIC
  );
  active_liquid_glass_state_count += 1;
  state.counted = YES;
  __weak BuddyLiquidGlassState *weakState = state;
  state.closeObserver = [NSNotificationCenter.defaultCenter
    addObserverForName:NSWindowWillCloseNotification
                object:window
                 queue:NSOperationQueue.mainQueue
            usingBlock:^(__unused NSNotification *notification) {
              BuddyLiquidGlassState *strongState = weakState;
              cleanup_liquid_glass_state(strongState, YES);
            }];
  return true;
}

static bool update_liquid_glass_on_main(
  NSView *providedView,
  BuddyLiquidGlassOptions *options,
  NSString **error
) API_AVAILABLE(macos(26.0)) {
  NSWindow *window = providedView.window;
  if (window == nil) {
    *error = @"the native view is not attached to a window";
    return false;
  }
  BuddyLiquidGlassState *state = objc_getAssociatedObject(window, buddy_liquid_glass_state_key);
  if (state == nil) {
    *error = @"Liquid Glass is not installed on this window";
    return false;
  }
  if (!validate_installed_liquid_glass_state(state, window, providedView, error)) return false;
  apply_liquid_glass_options(state.glassView, options);
  return true;
}

static bool remove_liquid_glass_on_main(NSView *providedView, NSString **error)
  API_AVAILABLE(macos(26.0)) {
  NSWindow *window = providedView.window;
  if (window == nil) {
    *error = @"the native view is not attached to a window";
    return false;
  }
  BuddyLiquidGlassState *state = objc_getAssociatedObject(window, buddy_liquid_glass_state_key);
  if (state == nil) {
    if (window.contentView != providedView) {
      *error = @"the native handle is not the NSWindow content view";
      return false;
    }
    return true;
  }
  if (!validate_installed_liquid_glass_state(state, window, providedView, error)) return false;
  cleanup_liquid_glass_state(state, YES);
  return true;
}

static bool copy_native_view_handle(
  napi_env env,
  napi_callback_info info,
  size_t expectedArgumentCount,
  napi_value *arguments,
  NSView **view,
  NSString **optionsJSON,
  NSString **error
) {
  size_t argc = expectedArgumentCount;
  if (napi_get_cb_info(env, info, &argc, arguments, NULL, NULL) != 0 ||
      argc != expectedArgumentCount) {
    *error = @"invalid argument count";
    return false;
  }
  void *bufferData = NULL;
  size_t bufferLength = 0;
  if (napi_get_buffer_info(env, arguments[0], &bufferData, &bufferLength) != 0 ||
      bufferData == NULL || bufferLength != sizeof(void *)) {
    *error = @"native handle must be a pointer-sized Buffer";
    return false;
  }
  void *pointer = *(void **)bufferData;
  if (pointer == NULL) {
    *error = @"native handle contains a null view pointer";
    return false;
  }
  *view = (__bridge NSView *)pointer;

  if (optionsJSON != NULL) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, arguments[1], NULL, 0, &length) != 0 ||
        length == 0 || length > 4096) {
      *error = @"options must be a non-empty JSON string up to 4096 bytes";
      return false;
    }
    char *buffer = calloc(length + 1, 1);
    if (buffer == NULL ||
        napi_get_value_string_utf8(env, arguments[1], buffer, length + 1, &length) != 0) {
      free(buffer);
      *error = @"could not read options JSON";
      return false;
    }
    *optionsJSON = [[NSString alloc] initWithBytes:buffer
                                           length:length
                                         encoding:NSUTF8StringEncoding];
    free(buffer);
    if (*optionsJSON == nil) {
      *error = @"options must be valid UTF-8";
      return false;
    }
  }
  return true;
}

static napi_value supports_liquid_glass(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != 0 || argc != 0) {
    return throw_liquid_glass_error(env, @"supportsLiquidGlass takes no arguments");
  }
  napi_value result = NULL;
  napi_get_boolean(env, liquid_glass_is_supported(), &result);
  return result;
}

typedef NS_ENUM(NSInteger, BuddyLiquidGlassOperation) {
  BuddyLiquidGlassOperationInstall,
  BuddyLiquidGlassOperationUpdate,
  BuddyLiquidGlassOperationRemove,
};

static napi_value run_liquid_glass_operation(
  napi_env env,
  napi_callback_info info,
  BuddyLiquidGlassOperation operation
) {
  if (!liquid_glass_is_supported()) {
    return throw_liquid_glass_error(env, @"requires macOS 26 or newer");
  }

  @autoreleasepool {
    size_t argumentCount = operation == BuddyLiquidGlassOperationRemove ? 1 : 2;
    napi_value arguments[2] = { NULL, NULL };
    NSView *view = nil;
    NSString *optionsJSON = nil;
    NSString *error = nil;
    if (!copy_native_view_handle(
          env,
          info,
          argumentCount,
          arguments,
          &view,
          operation == BuddyLiquidGlassOperationRemove ? NULL : &optionsJSON,
          &error
        )) {
      return throw_liquid_glass_error(env, error);
    }

    __block bool succeeded = false;
    __block NSString *operationError = nil;
    void (^operationBlock)(void) = ^{
      if (@available(macOS 26.0, *)) {
        if (![view isKindOfClass:NSView.class]) {
          operationError = @"native handle does not reference an NSView";
          return;
        }
        BuddyLiquidGlassOptions *options = nil;
        if (operation != BuddyLiquidGlassOperationRemove) {
          options = parse_liquid_glass_options(optionsJSON, &operationError);
          if (options == nil) return;
        }
        switch (operation) {
          case BuddyLiquidGlassOperationInstall:
            succeeded = install_liquid_glass_on_main(view, options, &operationError);
            break;
          case BuddyLiquidGlassOperationUpdate:
            succeeded = update_liquid_glass_on_main(view, options, &operationError);
            break;
          case BuddyLiquidGlassOperationRemove:
            succeeded = remove_liquid_glass_on_main(view, &operationError);
            break;
        }
      } else {
        operationError = @"requires macOS 26 or newer";
      }
    };
    if (NSThread.isMainThread) {
      operationBlock();
    } else {
      dispatch_sync(dispatch_get_main_queue(), operationBlock);
    }
    if (!succeeded) {
      return throw_liquid_glass_error(
        env,
        operationError == nil ? @"the native operation failed" : operationError
      );
    }
    napi_value result = NULL;
    napi_get_boolean(env, true, &result);
    return result;
  }
}

static napi_value install_liquid_glass(napi_env env, napi_callback_info info) {
  return run_liquid_glass_operation(env, info, BuddyLiquidGlassOperationInstall);
}

static napi_value update_liquid_glass(napi_env env, napi_callback_info info) {
  return run_liquid_glass_operation(env, info, BuddyLiquidGlassOperationUpdate);
}

static napi_value remove_liquid_glass(napi_env env, napi_callback_info info) {
  return run_liquid_glass_operation(env, info, BuddyLiquidGlassOperationRemove);
}

static napi_value set_liquid_glass_regions(napi_env env, napi_callback_info info) {
  if (!liquid_glass_is_supported()) {
    return throw_liquid_glass_error(env, @"requires macOS 26 or newer");
  }
  @autoreleasepool {
    napi_value arguments[2] = { NULL, NULL };
    NSView *view = nil;
    NSString *payloadJSON = nil;
    NSString *argumentError = nil;
    if (!copy_native_view_handle(
          env, info, 2, arguments, &view, &payloadJSON, &argumentError
        )) {
      return throw_liquid_glass_error(env, argumentError);
    }
    __block bool succeeded = false;
    __block NSString *operationError = nil;
    void (^operationBlock)(void) = ^{
      if (@available(macOS 26.0, *)) {
        if (![view isKindOfClass:NSView.class]) {
          operationError = @"native handle does not reference an NSView";
          return;
        }
        BuddyLiquidGlassRegionsPayload *payload = parse_liquid_glass_regions_payload(
          payloadJSON, &operationError
        );
        if (payload == nil) return;
        succeeded = set_liquid_glass_regions_on_main(view, payload, &operationError);
      } else {
        operationError = @"requires macOS 26 or newer";
      }
    };
    if (NSThread.isMainThread) operationBlock();
    else dispatch_sync(dispatch_get_main_queue(), operationBlock);
    if (!succeeded) {
      return throw_liquid_glass_error(
        env,
        operationError == nil ? @"the native region operation failed" : operationError
      );
    }
    napi_value result = NULL;
    napi_get_boolean(env, true, &result);
    return result;
  }
}

static napi_value inspect_liquid_glass_regions(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value arguments[1] = { NULL };
    NSView *view = nil;
    NSString *argumentError = nil;
    if (!copy_native_view_handle(env, info, 1, arguments, &view, NULL, &argumentError)) {
      return throw_liquid_glass_error(env, argumentError);
    }
    __block bool installed = false;
    __block NSUInteger regionCount = 0;
    __block NSUInteger stateCount = 0;
    __block bool hierarchyValid = false;
    __block bool electronAboveRegions = false;
    __block NSString *containerClass = nil;
    __block NSString *inspectionError = nil;
    void (^inspectionBlock)(void) = ^{
      if (@available(macOS 26.0, *)) {
        NSWindow *window = view.window;
        if (window == nil) {
          inspectionError = @"the native view is not attached to a window";
          return;
        }
        stateCount = active_liquid_glass_regions_state_count;
        BuddyLiquidGlassRegionsState *state = objc_getAssociatedObject(
          window, buddy_liquid_glass_regions_state_key
        );
        if (state == nil) return;
        installed = true;
        regionCount = state.regionViews.count;
        containerClass = NSStringFromClass(state.containerView.class);
        hierarchyValid = validate_liquid_glass_regions_state(
          state, window, view, &inspectionError
        );
        electronAboveRegions = state.backingWindow.parentWindow == window;
        for (NSGlassEffectView *glass in state.regionViews.allValues) {
          if (glass.superview != state.hostView) {
            electronAboveRegions = false;
          }
        }
      }
    };
    if (NSThread.isMainThread) inspectionBlock();
    else dispatch_sync(dispatch_get_main_queue(), inspectionBlock);
    if (inspectionError != nil) return throw_liquid_glass_error(env, inspectionError);

    napi_value result = NULL;
    if (napi_create_object(env, &result) != 0) {
      return throw_liquid_glass_error(env, @"could not create the region inspection result");
    }
    set_boolean(env, result, "supported", liquid_glass_is_supported());
    set_boolean(env, result, "installed", installed);
    set_number(env, result, "activeStateCount", stateCount);
    set_number(env, result, "regionCount", regionCount);
    set_boolean(env, result, "hierarchyValid", hierarchyValid);
    set_boolean(env, result, "electronAboveRegions", electronAboveRegions);
    if (containerClass == nil) set_null(env, result, "containerClass");
    else set_string(env, result, "containerClass", containerClass);
    return result;
  }
}

static NSString *liquid_glass_tint_hex(NSColor *color) API_AVAILABLE(macos(26.0)) {
  if (color == nil) return nil;
  NSColor *srgb = [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
  if (srgb == nil) return nil;
  NSInteger red = (NSInteger)llround(srgb.redComponent * 255.0);
  NSInteger green = (NSInteger)llround(srgb.greenComponent * 255.0);
  NSInteger blue = (NSInteger)llround(srgb.blueComponent * 255.0);
  NSInteger alpha = (NSInteger)llround(srgb.alphaComponent * 255.0);
  return [NSString stringWithFormat:@"#%02lX%02lX%02lX%02lX",
    (long)red, (long)green, (long)blue, (long)alpha];
}

/* Read-only diagnostics used by the Electron lifecycle smoke test and support tooling. */
static napi_value inspect_liquid_glass(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value arguments[1] = { NULL };
    NSView *view = nil;
    NSString *argumentError = nil;
    if (!copy_native_view_handle(
          env, info, 1, arguments, &view, NULL, &argumentError
        )) {
      return throw_liquid_glass_error(env, argumentError);
    }

    const bool supported = liquid_glass_is_supported();
    __block bool installed = false;
    __block NSUInteger stateCount = 0;
    __block NSString *wrapperClass = nil;
    __block NSString *handleRole = @"unmanaged";
    __block bool contentMatches = false;
    __block bool sameWindow = false;
    __block NSInteger hierarchyDepth = 0;
    __block NSString *style = nil;
    __block NSNumber *cornerRadius = nil;
    __block NSString *tintColor = nil;
    __block NSRect nativeViewFrame = NSZeroRect;
    __block NSNumber *nativeViewAutoresizingMask = nil;
    __block NSString *inspectionError = nil;

    if (supported) {
      void (^inspectionBlock)(void) = ^{
        if (@available(macOS 26.0, *)) {
          if (![view isKindOfClass:NSView.class]) {
            inspectionError = @"native handle does not reference an NSView";
            return;
          }
          NSWindow *window = view.window;
          if (window == nil) {
            inspectionError = @"the native view is not attached to a window";
            return;
          }
          nativeViewFrame = view.frame;
          nativeViewAutoresizingMask = @(view.autoresizingMask);
          stateCount = active_liquid_glass_state_count;
          BuddyLiquidGlassState *state = objc_getAssociatedObject(
            window, buddy_liquid_glass_state_key
          );
          if (state == nil) return;

          installed = true;
          wrapperClass = NSStringFromClass(state.glassView.class);
          if (view == state.electronView) {
            handleRole = @"electron";
          } else if (view == state.glassView) {
            handleRole = @"wrapper";
          }
          contentMatches = state.glassView.contentView == state.electronView;
          sameWindow = state.window == window && state.glassView.window == window &&
            state.electronView.window == window;

          NSView *ancestor = state.electronView;
          NSInteger depth = 0;
          while (ancestor != nil && ancestor != state.glassView && depth < 128) {
            ancestor = ancestor.superview;
            depth += 1;
          }
          hierarchyDepth = ancestor == state.glassView ? depth : -1;
          style = state.glassView.style == NSGlassEffectViewStyleClear ? @"clear" : @"regular";
          cornerRadius = @(state.glassView.cornerRadius);
          tintColor = liquid_glass_tint_hex(state.glassView.tintColor);
        }
      };
      if (NSThread.isMainThread) {
        inspectionBlock();
      } else {
        dispatch_sync(dispatch_get_main_queue(), inspectionBlock);
      }
    }
    if (inspectionError != nil) return throw_liquid_glass_error(env, inspectionError);

    napi_value result = NULL;
    if (napi_create_object(env, &result) != 0) {
      return throw_liquid_glass_error(env, @"could not create the inspection result");
    }
    set_boolean(env, result, "supported", supported);
    set_boolean(env, result, "installed", installed);
    set_number(env, result, "activeStateCount", stateCount);
    if (wrapperClass == nil) set_null(env, result, "wrapperClass");
    else set_string(env, result, "wrapperClass", wrapperClass);
    set_string(env, result, "nativeHandleRole", handleRole);
    set_boolean(env, result, "contentMatchesElectronView", contentMatches);
    set_boolean(env, result, "sameWindow", sameWindow);
    set_number(env, result, "hierarchyDepth", hierarchyDepth);
    if (style == nil) set_null(env, result, "style");
    else set_string(env, result, "style", style);
    if (cornerRadius == nil) set_null(env, result, "cornerRadius");
    else set_number(env, result, "cornerRadius", cornerRadius.doubleValue);
    if (tintColor == nil) set_null(env, result, "tintColor");
    else set_string(env, result, "tintColor", tintColor);
    if (nativeViewAutoresizingMask == nil) {
      set_null(env, result, "nativeViewFrame");
      set_null(env, result, "nativeViewAutoresizingMask");
    } else {
      set_rect(env, result, "nativeViewFrame", nativeViewFrame);
      set_number(
        env,
        result,
        "nativeViewAutoresizingMask",
        nativeViewAutoresizingMask.doubleValue
      );
    }
    return result;
  }
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
    { "queryFocusedReceiver", 20, query_focused_receiver },
    { "restoreFocusedReceiver", 22, restore_focused_receiver },
    { "prepareFocusedReceiverTypeText", 30, prepare_focused_receiver_type_text },
    { "verifyFocusedReceiverTypeText", 29, verify_focused_receiver_type_text },
    { "postInput", 9, post_input },
    { "supportsLiquidGlass", 19, supports_liquid_glass },
    { "installLiquidGlass", 18, install_liquid_glass },
    { "updateLiquidGlass", 17, update_liquid_glass },
    { "removeLiquidGlass", 17, remove_liquid_glass },
    { "inspectLiquidGlass", 18, inspect_liquid_glass },
    { "setLiquidGlassRegions", 21, set_liquid_glass_regions },
    { "inspectLiquidGlassRegions", 25, inspect_liquid_glass_regions },
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
