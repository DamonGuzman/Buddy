#include <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>
#include <stddef.h>

/*
 * Minimal Node-API declarations keep this tiny bridge independent of a
 * machine-specific Node/Electron header download. Node-API symbols are
 * resolved from Electron at load time (`-undefined dynamic_lookup`).
 */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
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

static napi_value request_screen_capture_access(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result = NULL;
  napi_get_boolean(env, CGRequestScreenCaptureAccess(), &result);
  return result;
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value request = NULL;
  if (napi_create_function(
        env,
        "requestScreenCaptureAccess",
        26,
        request_screen_capture_access,
        NULL,
        &request
      ) != 0) {
    return exports;
  }
  napi_set_named_property(env, exports, "requestScreenCaptureAccess", request);
  return exports;
}
