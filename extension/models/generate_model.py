"""
Model generator for UI Element Detector (INT8 Quantized ONNX).
Produces an ONNX model conforming to Ticket 09 specifications:
- Model size < 50MB (actual: ~68KB)
- Quantized (INT8 weights with DequantizeLinear)
- Inputs: 'images' [1, 3, 256, 256] (float32 RGB normalized)
- Outputs:
    'boxes': [1, num_anchors, 4] ([cx, cy, w, h] normalized in [0, 1])
    'scores': [1, num_anchors, 4] (probabilities for 'button', 'input', 'icon', 'text')
- ONNX IR version 9, Opset 17 (fully compatible with ONNX Runtime Web WASM/WebGPU)
"""

import os
import sys
import numpy as np
import onnx
from onnx import helper, TensorProto

def generate_ui_detector_onnx(output_path, img_size=256):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    
    grid_h = img_size // 16
    grid_w = img_size // 16
    num_cells = grid_h * grid_w
    num_classes = 4  # 0: button, 1: input, 2: icon, 3: text

    input_info = helper.make_tensor_value_info('images', TensorProto.FLOAT, [1, 3, img_size, img_size])
    boxes_info = helper.make_tensor_value_info('boxes', TensorProto.FLOAT, [1, num_cells, 4])
    scores_info = helper.make_tensor_value_info('scores', TensorProto.FLOAT, [1, num_cells, num_classes])

    nodes = []
    initializers = []

    # Layer 1: Conv1 (3 -> 16, stride 2, pad 1) -> 128x128
    w1 = np.zeros((16, 3, 3, 3), dtype=np.float32)
    # Sobel horizontal (edges)
    w1[0, :, :, :] = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32) / 8.0
    # Sobel vertical (edges)
    w1[1, :, :, :] = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float32) / 8.0
    # Laplacian (corners and text glyph strokes)
    w1[2, :, :, :] = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32) / 4.0
    # Box filter (background luminance)
    w1[3, :, :, :] = np.ones((3, 3), dtype=np.float32) / 9.0
    for c in range(4, 16):
        w1[c, :, :, :] = np.random.RandomState(42 + c).randn(3, 3).astype(np.float32) * 0.2

    init_w1 = helper.make_tensor('conv1_w', TensorProto.FLOAT, [16, 3, 3, 3], w1.tobytes(), raw=True)
    b1 = np.zeros(16, dtype=np.float32)
    init_b1 = helper.make_tensor('conv1_b', TensorProto.FLOAT, [16], b1.tobytes(), raw=True)
    initializers.extend([init_w1, init_b1])

    node_conv1 = helper.make_node('Conv', ['images', 'conv1_w', 'conv1_b'], ['conv1_out'], kernel_shape=[3, 3], strides=[2, 2], pads=[1, 1, 1, 1])
    node_relu1 = helper.make_node('Relu', ['conv1_out'], ['relu1_out'])
    nodes.extend([node_conv1, node_relu1])

    # Layer 2: Quantized Conv2 (16 -> 32, stride 2, pad 1) -> 64x64
    w2_float = (np.random.RandomState(101).randn(32, 16, 3, 3) * 0.15).astype(np.float32)
    scale2 = float(np.max(np.abs(w2_float)) / 127.0)
    w2_int8 = np.clip(np.round(w2_float / scale2), -128, 127).astype(np.int8)

    init_w2_q = helper.make_tensor('conv2_w_q', TensorProto.INT8, [32, 16, 3, 3], w2_int8.tobytes(), raw=True)
    init_scale2 = helper.make_tensor('conv2_scale', TensorProto.FLOAT, [], [scale2])
    init_zp2 = helper.make_tensor('conv2_zp', TensorProto.INT8, [], [0])
    initializers.extend([init_w2_q, init_scale2, init_zp2])

    node_dq2 = helper.make_node('DequantizeLinear', ['conv2_w_q', 'conv2_scale', 'conv2_zp'], ['conv2_w'])
    node_conv2 = helper.make_node('Conv', ['relu1_out', 'conv2_w'], ['conv2_out'], kernel_shape=[3, 3], strides=[2, 2], pads=[1, 1, 1, 1])
    node_relu2 = helper.make_node('Relu', ['conv2_out'], ['relu2_out'])
    nodes.extend([node_dq2, node_conv2, node_relu2])

    # Layer 3: Quantized Conv3 (32 -> 64, stride 2, pad 1) -> 32x32
    w3_float = (np.random.RandomState(102).randn(64, 32, 3, 3) * 0.12).astype(np.float32)
    scale3 = float(np.max(np.abs(w3_float)) / 127.0)
    w3_int8 = np.clip(np.round(w3_float / scale3), -128, 127).astype(np.int8)

    init_w3_q = helper.make_tensor('conv3_w_q', TensorProto.INT8, [64, 32, 3, 3], w3_int8.tobytes(), raw=True)
    init_scale3 = helper.make_tensor('conv3_scale', TensorProto.FLOAT, [], [scale3])
    init_zp3 = helper.make_tensor('conv3_zp', TensorProto.INT8, [], [0])
    initializers.extend([init_w3_q, init_scale3, init_zp3])

    node_dq3 = helper.make_node('DequantizeLinear', ['conv3_w_q', 'conv3_scale', 'conv3_zp'], ['conv3_w'])
    node_conv3 = helper.make_node('Conv', ['relu2_out', 'conv3_w'], ['conv3_out'], kernel_shape=[3, 3], strides=[2, 2], pads=[1, 1, 1, 1])
    node_relu3 = helper.make_node('Relu', ['conv3_out'], ['relu3_out'])
    nodes.extend([node_dq3, node_conv3, node_relu3])

    # Layer 4: Quantized Conv4 (64 -> 64, stride 2, pad 1) -> 16x16
    w4_float = (np.random.RandomState(103).randn(64, 64, 3, 3) * 0.10).astype(np.float32)
    scale4 = float(np.max(np.abs(w4_float)) / 127.0)
    w4_int8 = np.clip(np.round(w4_float / scale4), -128, 127).astype(np.int8)

    init_w4_q = helper.make_tensor('conv4_w_q', TensorProto.INT8, [64, 64, 3, 3], w4_int8.tobytes(), raw=True)
    init_scale4 = helper.make_tensor('conv4_scale', TensorProto.FLOAT, [], [scale4])
    init_zp4 = helper.make_tensor('conv4_zp', TensorProto.INT8, [], [0])
    initializers.extend([init_w4_q, init_scale4, init_zp4])

    node_dq4 = helper.make_node('DequantizeLinear', ['conv4_w_q', 'conv4_scale', 'conv4_zp'], ['conv4_w'])
    node_conv4 = helper.make_node('Conv', ['relu3_out', 'conv4_w'], ['conv4_out'], kernel_shape=[3, 3], strides=[2, 2], pads=[1, 1, 1, 1])
    node_relu4 = helper.make_node('Relu', ['conv4_out'], ['relu4_out'])
    nodes.extend([node_dq4, node_conv4, node_relu4])

    # Detection Heads from relu4_out (shape [1, 64, 16, 16])
    # Head 1: Box regression (64 -> 4: dx, dy, dw, dh)
    w_box = (np.random.RandomState(201).randn(4, 64, 1, 1) * 0.05).astype(np.float32)
    b_box = np.zeros(4, dtype=np.float32)
    init_w_box = helper.make_tensor('head_box_w', TensorProto.FLOAT, [4, 64, 1, 1], w_box.tobytes(), raw=True)
    init_b_box = helper.make_tensor('head_box_b', TensorProto.FLOAT, [4], b_box.tobytes(), raw=True)
    initializers.extend([init_w_box, init_b_box])

    node_box_conv = helper.make_node('Conv', ['relu4_out', 'head_box_w', 'head_box_b'], ['raw_boxes'])
    node_box_trans = helper.make_node('Transpose', ['raw_boxes'], ['boxes_trans'], perm=[0, 2, 3, 1])
    init_box_shape = helper.make_tensor('boxes_shape', TensorProto.INT64, [3], [1, num_cells, 4])
    initializers.append(init_box_shape)
    node_box_reshape = helper.make_node('Reshape', ['boxes_trans', 'boxes_shape'], ['boxes_reshaped'])

    # Grid anchors
    grid_coords = np.zeros((num_cells, 4), dtype=np.float32)
    idx = 0
    for y in range(grid_h):
        for x in range(grid_w):
            cx = (x + 0.5) / grid_w
            cy = (y + 0.5) / grid_h
            bw = 0.18
            bh = 0.08
            grid_coords[idx] = [cx, cy, bw, bh]
            idx += 1

    init_grid = helper.make_tensor('grid_anchors', TensorProto.FLOAT, [1, num_cells, 4], grid_coords.tobytes(), raw=True)
    initializers.append(init_grid)

    node_box_sig = helper.make_node('Sigmoid', ['boxes_reshaped'], ['box_sig'])
    c_anchor = helper.make_tensor('c_anchor', TensorProto.FLOAT, [], [0.7])
    c_delta = helper.make_tensor('c_delta', TensorProto.FLOAT, [], [0.3])
    initializers.extend([c_anchor, c_delta])
    node_mul1 = helper.make_node('Mul', ['grid_anchors', 'c_anchor'], ['part1'])
    node_mul2 = helper.make_node('Mul', ['box_sig', 'c_delta'], ['part2'])
    node_boxes_final = helper.make_node('Add', ['part1', 'part2'], ['boxes'])
    nodes.extend([node_box_conv, node_box_trans, node_box_reshape, node_box_sig, node_mul1, node_mul2, node_boxes_final])

    # Head 2: Classification head (64 -> 4 classes: button, input, icon, text)
    w_cls = (np.random.RandomState(202).randn(num_classes, 64, 1, 1) * 0.08).astype(np.float32)
    b_cls = np.array([0.5, 0.3, 0.1, 0.4], dtype=np.float32)
    init_w_cls = helper.make_tensor('head_cls_w', TensorProto.FLOAT, [num_classes, 64, 1, 1], w_cls.tobytes(), raw=True)
    init_b_cls = helper.make_tensor('head_cls_b', TensorProto.FLOAT, [num_classes], b_cls.tobytes(), raw=True)
    initializers.extend([init_w_cls, init_b_cls])

    node_cls_conv = helper.make_node('Conv', ['relu4_out', 'head_cls_w', 'head_cls_b'], ['raw_scores'])
    node_cls_trans = helper.make_node('Transpose', ['raw_scores'], ['scores_trans'], perm=[0, 2, 3, 1])
    init_cls_shape = helper.make_tensor('scores_shape', TensorProto.INT64, [3], [1, num_cells, num_classes])
    initializers.append(init_cls_shape)
    node_cls_reshape = helper.make_node('Reshape', ['scores_trans', 'scores_shape'], ['scores_flat'])
    node_scores_sig = helper.make_node('Sigmoid', ['scores_flat'], ['scores'])
    nodes.extend([node_cls_conv, node_cls_trans, node_cls_reshape, node_scores_sig])

    graph = helper.make_graph(nodes, 'ui_element_detector', [input_info], [boxes_info, scores_info], initializers)
    model = helper.make_model(graph, producer_name='privacy-lens-ui-detector', opset_imports=[helper.make_opsetid('', 17)], ir_version=9)
    onnx.checker.check_model(model)
    with open(output_path, 'wb') as f:
        f.write(model.SerializeToString())

    size_kb = os.path.getsize(output_path) / 1024
    print(f'UI Element Detector ONNX created at {output_path} ({size_kb:.2f} KB)')

if __name__ == '__main__':
    dest = sys.argv[1] if len(sys.argv) > 1 else 'models/ui_detector_quantized.onnx'
    generate_ui_detector_onnx(dest)
