"""
ComfyUI Prompt Studio
=====================
仿 WebUI 提示词页面的 ComfyUI 提示词编辑器（悬浮面板）。

特点：
- 正 / 负提示词双栏编辑，逗号切分成彩色标签，可拖动排序
- Danbooru / e621 / 双站合并 三个检索页签，支持中文反查
- 下方提示词整合分组（人物 / 服饰 / 表情动作 / 画面 / 环境 / 场景 / 物品 / 镜头 / 汉服 / 魔法系 / 反向提示词）
- 右侧预设提示词（保存 / 删除 / 插入正负提示词，支持 {prompt} 占位符）
- 在 CLIP 文本编码节点上挂一个开关按钮，点开面板

面板只做编辑，不改节点、不注入提示词，复制后自行粘贴回 ComfyUI。
"""

import os

from . import prompt_studio_server  # noqa: F401  导入即注册 HTTP 路由

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__version__ = prompt_studio_server.VERSION

prompt_studio_server.warmup_async()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
