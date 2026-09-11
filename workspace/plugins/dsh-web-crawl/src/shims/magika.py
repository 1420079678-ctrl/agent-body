# -*- coding: utf-8 -*-
"""magika shim — 轻量替身，替代 markitdown 依赖的 magika + onnxruntime（43MB）。

背景：markitdown 在 `_markitdown.py:15` 顶层 `import magika`，并在
`_get_stream_info_guesses()` 里用它做「按内容嗅探文件类型」。那是**增强**而非必需：
当 magika 返回 status != "ok"（或 label == "unknown"）时，markitdown 直接走
`enhanced_guess`——即基于文件扩展名 / mimetype 的判据。

本插件的文档转换始终带着正确扩展名（临时文件按源 URL 的扩展名命名），所以扩展名
判据已经足够准确；magika 的 40MB onnxruntime 运行时在这里是纯负担。

因此这个替身让 `identify_stream()` 稳定返回 unknown，让 markitdown 走扩展名路径。
注意 markitdown 的调用点只有 `try/finally` 没有 `except`，**替身绝不能抛异常**。
"""
from __future__ import annotations


class _Output:
    label = 'unknown'
    is_text = False
    mime_type = 'application/octet-stream'
    extensions: list = []
    description = ''
    group = 'unknown'
    score = 0.0


class _Prediction:
    output = _Output()


class _Result:
    status = 'unknown'
    prediction = _Prediction()


class Magika:
    """与 magika.Magika 同形的最小接口，恒返回 unknown。"""

    def __init__(self, *args, **kwargs) -> None:
        pass

    def identify_stream(self, stream, *args, **kwargs) -> _Result:
        return _Result()

    def identify_bytes(self, data, *args, **kwargs) -> _Result:
        return _Result()

    def identify_path(self, path, *args, **kwargs) -> _Result:
        return _Result()

    def identify_paths(self, paths, *args, **kwargs):
        return [_Result() for _ in paths]


__version__ = '0.0.0-dsh-shim'
