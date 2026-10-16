"""Topview 3D scene editor: no agent, external service, or Node runtime required."""
from .backend import Topview3DScene, register_routes

NODE_CLASS_MAPPINGS = {"Topview3DScene": Topview3DScene}
NODE_DISPLAY_NAME_MAPPINGS = {"Topview3DScene": "Topview 3D Builder"}
WEB_DIRECTORY = "./web"
register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
