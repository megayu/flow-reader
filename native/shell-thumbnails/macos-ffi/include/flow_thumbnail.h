#ifndef FLOW_THUMBNAIL_H
#define FLOW_THUMBNAIL_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct FlowThumbnailRequest {
  uint32_t max_width;
  uint32_t max_height;
  float scale;
} FlowThumbnailRequest;

typedef struct FlowThumbnailOutput {
  uint8_t *pixels;
  size_t len;
  uint32_t width;
  uint32_t height;
  size_t stride;
  uint8_t has_alpha;
} FlowThumbnailOutput;

typedef enum FlowThumbnailStatus {
  FLOW_THUMBNAIL_OK = 0,
  FLOW_THUMBNAIL_INVALID_ARGUMENT = 1,
  FLOW_THUMBNAIL_RENDER_ERROR = 2,
  FLOW_THUMBNAIL_PANIC = 3,
} FlowThumbnailStatus;

FlowThumbnailStatus flow_thumbnail_render_file(
    const uint8_t *path,
    size_t path_len,
    FlowThumbnailRequest request,
    FlowThumbnailOutput *output);

const uint8_t *flow_thumbnail_status_message(
    int32_t status,
    size_t *message_len);

void flow_thumbnail_free(FlowThumbnailOutput *output);

#ifdef __cplusplus
}
#endif

#endif
